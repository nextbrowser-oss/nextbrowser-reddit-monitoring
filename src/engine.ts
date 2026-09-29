// One monitoring pass: who is signed in, what is new in the inbox, which new
// posts and comments name a keyword, how urgent each one is, and whether the
// account's karma or a watched community's subscriber count moved.
//
// The pass is a state machine over an explicit MonitorState, like the X
// monitor: it takes the state in, returns the next state and the events out,
// and never mutates what it was given. The caller persists the state and
// schedules the next pass; the pass itself never sleeps longer than the pause
// between two requests.
//
// Everything is read, nothing is done: no vote, no comment, no reply, no
// subscription, and the inbox is read with mark=false so not even the unread
// dot changes. Answering is the reply agent's job, with the person's approval.

import type { MonitorBrowser } from "./browser.js";
import type { ItemSource, Match, MonitorEvent } from "./events.js";
import { isOwn, matchText, normalizeItems } from "./items.js";
import { keywordMatcher, searchQueries, signature, type Matcher } from "./keywords.js";
import { errorText, makeLogger, type LogSink, type Logger } from "./log.js";
import {
  LANDING_URL,
  SIGN_IN_URL,
  aboutScript,
  communityCommentsPath,
  communityPostsPath,
  inboxPath,
  listingScript,
  meScript,
  originScript,
  searchPath,
  type AboutSnapshot,
  type FetchMeta,
  type ListingSnapshot,
  type MeSnapshot,
  type OriginSnapshot,
} from "./scripts.js";
import {
  MAX_HISTORY,
  MAX_PASS_NOTES,
  MAX_SEEN,
  countsDue,
  normalizeState,
  normalizeUsername,
  type CommunityStats,
  type KarmaStats,
  type MonitorState,
  type SourceState,
} from "./state.js";
import { byUrgency, triage } from "./triage.js";

const BLANK_PAGE = "about:blank";
const LOAD_WAIT_SECONDS = 15;
/** Below this many requests left in reddit.com's rate-limit window the pass
 *  stops asking: the rest waits for the next pass rather than being refused. */
const RATE_FLOOR = 3;

export type Sleep = (ms: number) => Promise<void>;

export const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface PassDeps {
  browser: MonitorBrowser;
  state: MonitorState;
  now?: () => number;
  sleep?: Sleep;
  /** A source of numbers in [0, 1), for the pauses a person would take. */
  random?: () => number;
  log?: LogSink;
  /** Called for every event as it happens, before the pass returns. */
  onEvent?: (event: MonitorEvent) => void;
  /** Called with what the pass is doing, for a status line. */
  onStep?: (step: string) => void;
  /** Checked between requests, so Stop ends the pass instead of waiting it
   *  out. */
  shouldStop?: () => boolean;
}

export interface PassSummary {
  signedIn: boolean;
  handle?: string;
  /** The settings ask for something only a signed-in profile can read — the
   *  inbox or the karma — and the profile is signed out. Public reads went on. */
  loginRequired: boolean;
  /** Why the pass stopped reading: reddit.com refused the profile or could not
   *  be reached. The next pass should wait longer (scheduleDelay backOff). */
  blocked?: string;
  /** reddit.com's rate limit for the account ran low and the pass stopped
   *  early. */
  rateLimited: boolean;
  /** Requests made to reddit.com. */
  requests: number;
  sourcesRead: number;
  /** Sources read for the first time, or with a new keyword set: what they
   *  hold is the starting line, and nothing in them is announced. */
  baselines: number;
  itemsRead: number;
  /** Items that matched, new or not, inside the age window. */
  matches: number;
  newItems: number;
  /** New items triaged as high urgency. */
  urgent: number;
  countChecks: number;
  countChanges: number;
  stopped: boolean;
  notes: string[];
}

export interface PassResult {
  state: MonitorState;
  events: MonitorEvent[];
  summary: PassSummary;
  /** Every item this pass found that matched, new or not, inside the age
   *  window, most urgent first. The events say what is new; this is what a
   *  dashboard shows — including after a first pass, which announces nothing. */
  matches: Match[];
}

export interface AccountCheck {
  signedIn: boolean;
  handle?: string;
  karma?: number;
  /** Why reddit.com could not be read at all. */
  blocked?: string;
}

class StopRequested extends Error {}
class Blocked extends Error {}
class RateLimited extends Error {}

/** refusal names what a request came back with, when it is something a pass
 *  cannot go on after, or returns undefined. */
function refusal(meta: FetchMeta): string | undefined {
  if (meta.status === 0 && meta.error) return `reddit.com could not be reached (${meta.error}).`;
  // A community that does not exist can answer 404 with a page instead of
  // JSON; that is about the community, not about the profile.
  if (meta.refused && meta.status !== 404) return `reddit.com refused the request (HTTP ${meta.status}: ${meta.refused}).`;
  return undefined;
}

/** checkAccount opens reddit.com and reads who is signed in, and stops there:
 *  no inbox, no listings, and the page is left open, since it is what a person
 *  who is about to sign in wants in front of them. It is what a panel calls to
 *  show the account before any monitoring has run. */
export async function checkAccount(deps: { browser: MonitorBrowser; now?: () => number; log?: LogSink }): Promise<AccountCheck> {
  const log = makeLogger(deps.log, deps.now ?? Date.now);
  await deps.browser.open(SIGN_IN_URL);
  await deps.browser.waitForLoad(LOAD_WAIT_SECONDS).catch(() => undefined);
  const where = await deps.browser.evaluate<OriginSnapshot>(originScript(), "origin");
  if (where.refused) return { signedIn: false, blocked: `reddit.com refused the profile: ${where.refused}` };
  const me = await deps.browser.evaluate<MeSnapshot>(meScript(), "me");
  log("identity", { status: me.status, signed_in: me.signed_in, name: me.name, refused: me.refused, error: me.error });
  const blocked = refusal(me);
  if (blocked) return { signedIn: false, blocked };
  const handle = normalizeUsername(me.name);
  return {
    signedIn: me.signed_in,
    ...(me.signed_in && handle ? { handle } : {}),
    ...(me.signed_in && me.total_karma !== null ? { karma: me.total_karma } : {}),
  };
}

/** runPass runs one monitoring pass. It does not throw for anything reddit.com
 *  or the browser does; failures end up in the summary's notes and the log. */
export async function runPass(deps: PassDeps): Promise<PassResult> {
  return new Pass(deps).run();
}

interface PlannedSource {
  key: string;
  source: ItemSource;
  path: string;
  /** What the listing is filtered by, for SourceState.filter. */
  filter: string;
  /** Whether an item must name a keyword to count. */
  filtered: boolean;
  inbox: boolean;
}

class Pass {
  private readonly browser: MonitorBrowser;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly log: Logger;
  private readonly deps: PassDeps;
  private readonly at: number;
  private state: MonitorState;
  private readonly events: MonitorEvent[] = [];
  private readonly matches = new Map<string, Match>();
  private seen: Set<string>;
  private seenOrder: string[];
  private readonly sources: Record<string, SourceState> = {};
  private remaining: number | null = null;
  private readonly keywords: Matcher;
  private readonly excluded: Matcher;
  private readonly urgent: Matcher;
  private readonly summary: PassSummary = {
    signedIn: false,
    loginRequired: false,
    rateLimited: false,
    requests: 0,
    sourcesRead: 0,
    baselines: 0,
    itemsRead: 0,
    matches: 0,
    newItems: 0,
    urgent: 0,
    countChecks: 0,
    countChanges: 0,
    stopped: false,
    notes: [],
  };

  constructor(deps: PassDeps) {
    this.deps = deps;
    this.browser = deps.browser;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.log = makeLogger(deps.log, this.now);
    this.at = this.now();
    this.state = normalizeState(deps.state);
    this.seenOrder = [...this.state.seen];
    this.seen = new Set(this.seenOrder);
    const settings = this.state.settings;
    this.keywords = keywordMatcher(settings.keywords);
    this.excluded = keywordMatcher(settings.excludeKeywords);
    this.urgent = keywordMatcher(settings.urgentTerms);
  }

  async run(): Promise<PassResult> {
    this.log("pass_start", { settings: this.state.settings, account: this.state.account?.handle });
    const plan: PlannedSource[] = [];
    try {
      await this.land();
      await this.readAccount();
      plan.push(...this.plan());
      if (plan.length === 0 && !this.summary.loginRequired) this.note("Nothing to watch yet: add keywords or communities.");
      for (const source of plan) await this.readSource(source);
      await this.readCounts();
    } catch (error) {
      if (error instanceof StopRequested) {
        this.summary.stopped = true;
      } else if (error instanceof Blocked) {
        this.summary.blocked = error.message;
        this.note(error.message);
      } else if (error instanceof RateLimited) {
        this.summary.rateLimited = true;
        this.note("reddit.com's rate limit for this account ran low, so the pass stopped early; the rest is read next time.");
      } else {
        this.note(`The pass failed: ${errorText(error)}`);
        this.log("pass_error", { error: errorText(error) });
      }
    } finally {
      await this.park();
    }
    this.finish(plan);
    this.log("pass_end", { ...this.summary });
    const matches = [...this.matches.values()].sort(byUrgency);
    this.summary.matches = matches.length;
    return { state: this.state, events: this.events, summary: this.summary, matches };
  }

  // --- landing and account ---------------------------------------------------

  /** land puts the tab on reddit.com, which every read is fetched from. */
  private async land(): Promise<void> {
    this.step("Opening reddit.com");
    const current = await this.browser.evaluate<OriginSnapshot>(originScript(), "origin").catch(() => undefined);
    if (current?.on_reddit && !current.refused) return;
    await this.browser.open(LANDING_URL);
    await this.browser.waitForLoad(LOAD_WAIT_SECONDS).catch(() => undefined);
    const landed = await this.browser.evaluate<OriginSnapshot>(originScript(), "origin");
    this.log("landed", { ...landed });
    if (landed.refused) throw new Blocked(`reddit.com refused the profile: ${landed.refused}`);
    if (!landed.on_reddit) throw new Blocked(`The tab did not reach reddit.com (it shows ${landed.url}).`);
  }

  /** readAccount asks reddit.com who is signed in. A signed-out profile can
   *  still read communities and search; only the inbox and the karma need an
   *  account. */
  private async readAccount(): Promise<void> {
    this.step("Reading the signed-in account");
    const me = await this.fetch<MeSnapshot>(meScript(), "me");
    const previous = this.state.account;
    if (!me.ok) {
      // Neither signed in nor out: the account stays what it was.
      this.note(`reddit.com did not say who is signed in (HTTP ${me.status}${me.reason ? `, ${me.reason}` : ""}).`);
      if (previous?.signedIn && previous.handle) {
        this.summary.signedIn = true;
        this.summary.handle = previous.handle;
      }
      return;
    }
    if (!me.signed_in) {
      if (previous?.signedIn !== false) this.emit({ type: "signed_out", at: this.at, ...(previous?.handle ? { handle: previous.handle } : {}) });
      this.state = { ...this.state, account: { ...(previous?.handle ? { handle: previous.handle } : {}), signedIn: false, checkedAt: this.at } };
      const settings = this.state.settings;
      if (settings.watchInbox || settings.trackKarma) {
        this.summary.loginRequired = true;
        this.note("The profile is not signed in to reddit.com: mentions, replies and karma wait for a sign-in; communities and search are read as usual.");
      }
      return;
    }
    const handle = normalizeUsername(me.name) || previous?.handle;
    if (!previous?.signedIn) this.emit({ type: "signed_in", at: this.at, ...(handle ? { handle } : {}) });
    if (previous?.handle && handle && previous.handle.toLowerCase() !== handle.toLowerCase()) {
      this.emit({ type: "account_changed", at: this.at, previous: previous.handle, current: handle });
      // Another account has another inbox: it starts over as a baseline.
      const sources = Object.fromEntries(Object.entries(this.state.sources).filter(([key]) => key !== "inbox"));
      this.state = { ...this.state, sources };
    }
    this.state = { ...this.state, account: { ...(handle ? { handle } : {}), signedIn: true, checkedAt: this.at } };
    this.summary.signedIn = true;
    if (handle) this.summary.handle = handle;
    if (handle && this.state.settings.trackKarma) this.recordKarma(handle, me);
  }

  private recordKarma(handle: string, me: MeSnapshot): void {
    const total = me.total_karma ?? (me.link_karma !== null || me.comment_karma !== null ? (me.link_karma ?? 0) + (me.comment_karma ?? 0) : null);
    if (total === null) return;
    this.summary.countChecks += 1;
    const previous: KarmaStats | undefined = this.state.karma?.owner.toLowerCase() === handle.toLowerCase() ? this.state.karma : undefined;
    const next: KarmaStats = {
      owner: handle,
      total,
      ...(me.link_karma !== null ? { post: me.link_karma } : {}),
      ...(me.comment_karma !== null ? { comment: me.comment_karma } : {}),
      checkedAt: this.at,
      ...(previous?.changedAt !== undefined ? { changedAt: previous.changedAt } : {}),
      history: previous?.history ?? [],
    };
    if (previous?.total === undefined) {
      next.history = [...next.history, { at: this.at, value: total }].slice(-MAX_HISTORY);
    } else if (previous.total !== total) {
      this.emit({
        type: "karma_changed",
        at: this.at,
        handle,
        previous: previous.total,
        current: total,
        delta: total - previous.total,
        ...(next.post !== undefined ? { post: next.post } : {}),
        ...(next.comment !== undefined ? { comment: next.comment } : {}),
      });
      this.summary.countChanges += 1;
      next.changedAt = this.at;
      next.history = [...next.history, { at: this.at, value: total }].slice(-MAX_HISTORY);
    }
    this.state = { ...this.state, karma: next };
  }

  // --- listings --------------------------------------------------------------

  /** plan lists what this pass reads, in order: the inbox, which is addressed
   *  to the account and most likely to need an answer, then the communities,
   *  then the search. An item found by more than one is reported by the first. */
  private plan(): PlannedSource[] {
    const settings = this.state.settings;
    const limit = settings.itemLimit;
    const words = signature(settings.keywords);
    const hasKeywords = settings.keywords.length > 0;
    const plan: PlannedSource[] = [];
    if (this.summary.signedIn && settings.watchInbox) {
      plan.push({ key: "inbox", source: { kind: "inbox", name: "inbox" }, path: inboxPath(limit), filter: "", filtered: false, inbox: true });
    }
    for (const community of settings.communities) {
      const name = `r/${community}`;
      const key = `r/${community.toLowerCase()}`;
      plan.push({
        key: `${key}:posts`,
        source: { kind: "community", name },
        path: communityPostsPath(community, limit),
        filter: hasKeywords ? words : "all",
        filtered: hasKeywords,
        inbox: false,
      });
      if (hasKeywords && settings.watchComments) {
        plan.push({
          key: `${key}:comments`,
          source: { kind: "community", name },
          path: communityCommentsPath(community, Math.min(100, limit * 2)),
          filter: words,
          filtered: true,
          inbox: false,
        });
      }
    }
    if (hasKeywords && settings.searchAll) {
      for (const query of searchQueries(settings.keywords)) {
        plan.push({ key: `search:${query.toLowerCase()}`, source: { kind: "search", name: query }, path: searchPath(query, limit), filter: words, filtered: true, inbox: false });
      }
    }
    return plan;
  }

  private async readSource(planned: PlannedSource): Promise<void> {
    this.step(planned.inbox ? "Reading the inbox" : planned.source.kind === "search" ? "Searching Reddit" : `Reading ${planned.source.name}`);
    const listing = await this.fetch<ListingSnapshot>(listingScript(planned.path), `listing ${planned.key}`);
    const previous = this.state.sources[planned.key];
    if (!listing.ok) {
      const why = this.failure(planned, listing);
      this.note(why);
      if (previous) this.sources[planned.key] = { ...previous, note: why };
      return;
    }
    const items = normalizeItems(listing.items, { inbox: planned.inbox });
    this.summary.sourcesRead += 1;
    this.summary.itemsRead += items.length;

    const baseline = !previous || previous.filter !== planned.filter;
    const since = baseline ? this.at : previous.since;
    const maxAge = this.state.settings.maxItemAgeMs;
    const floor = maxAge > 0 ? Math.max(since, this.at - maxAge) : since;
    const handle = this.summary.handle;
    const fresh: Match[] = [];

    for (const item of items) {
      if (!planned.inbox && isOwn(item, handle)) continue;
      const { title, body } = matchText(item);
      const text = [title, body].filter(Boolean).join("\n");
      const keywords = planned.filtered ? this.keywords(text) : [];
      if (planned.filtered && keywords.length === 0) continue;
      if (!planned.inbox && this.excluded(text).length > 0) continue;
      const match: Match = { item, source: planned.source, keywords, triage: triage(item, { at: this.at, keywords, urgent: this.urgent }) };
      const inWindow = maxAge === 0 || (item.createdAt !== undefined && item.createdAt >= this.at - maxAge);
      if (inWindow && !this.matches.has(item.key)) this.matches.set(item.key, match);
      const isNew = !baseline && !this.seen.has(item.key) && item.createdAt !== undefined && item.createdAt >= floor;
      this.remember(item.key);
      if (isNew) fresh.push(match);
    }

    // Oldest first, the order they happened in.
    fresh.sort((left, right) => (left.item.createdAt ?? 0) - (right.item.createdAt ?? 0));
    const account = this.summary.handle;
    for (const match of fresh) {
      this.emit({ type: "new_item", at: this.at, ...(account ? { account } : {}), ...match });
      if (match.triage.urgency === "high") this.summary.urgent += 1;
    }
    this.summary.newItems += fresh.length;
    if (baseline) this.summary.baselines += 1;
    this.log("listing", { source: planned.key, baseline, read: items.length, fresh: fresh.length, status: listing.status });
    this.sources[planned.key] = {
      since,
      filter: planned.filter,
      lastReadAt: this.at,
      ...(fresh.length > 0 ? { lastNewAt: this.at } : previous?.lastNewAt !== undefined && !baseline ? { lastNewAt: previous.lastNewAt } : {}),
    };
  }

  /** failure says why a listing came back with nothing to go on. */
  private failure(planned: PlannedSource, meta: FetchMeta): string {
    const name = planned.source.kind === "search" ? `The search for ${planned.source.name}` : planned.inbox ? "The inbox" : planned.source.name;
    switch (meta.reason.toLowerCase()) {
      case "private":
        return `${name} is private.`;
      case "banned":
        return `${name} is banned.`;
      case "quarantined":
        return `${name} is quarantined: open it once in the profile and accept the warning.`;
      default:
        break;
    }
    if (meta.status === 404) return `${name} was not found.`;
    if (meta.status === 403) return `${name} is not open to this account (HTTP 403).`;
    return `${name} could not be read (HTTP ${meta.status}${meta.error ? `, ${meta.error}` : ""}).`;
  }

  private remember(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.seenOrder.push(key);
  }

  // --- counts ----------------------------------------------------------------

  private async readCounts(): Promise<void> {
    const settings = this.state.settings;
    if (!settings.trackSubscribers) return;
    for (const community of settings.communities) {
      if (!countsDue(this.state, community, this.at)) continue;
      this.step(`Reading r/${community}'s subscribers`);
      const about = await this.fetch<AboutSnapshot>(aboutScript(community), `about r/${community.toLowerCase()}`);
      this.recordSubscribers(community, about);
    }
  }

  private recordSubscribers(community: string, about: AboutSnapshot): void {
    const key = community.toLowerCase();
    const previous: CommunityStats = this.state.communities[key] ?? { name: community, history: [] };
    if (!about.found || about.subscribers === null) {
      const why = about.reason === "private"
        ? `r/${community} is private.`
        : about.reason === "banned"
          ? `r/${community} is banned.`
          : `r/${community} showed no subscriber count${about.ok ? " (it may not exist)" : ` (HTTP ${about.status})`}.`;
      this.note(why);
      this.setCommunity(key, { ...previous, attemptedAt: this.at, note: why });
      return;
    }
    this.summary.countChecks += 1;
    const subscribers = about.subscribers;
    const next: CommunityStats = {
      name: about.name || previous.name || community,
      subscribers,
      ...(about.active !== null ? { active: about.active } : {}),
      checkedAt: this.at,
      attemptedAt: this.at,
      ...(previous.changedAt !== undefined ? { changedAt: previous.changedAt } : {}),
      history: previous.history,
    };
    if (previous.subscribers === undefined) {
      next.history = [...previous.history, { at: this.at, value: subscribers }].slice(-MAX_HISTORY);
    } else if (previous.subscribers !== subscribers) {
      this.emit({ type: "subscribers_changed", at: this.at, community: next.name, previous: previous.subscribers, current: subscribers, delta: subscribers - previous.subscribers });
      this.summary.countChanges += 1;
      next.changedAt = this.at;
      next.history = [...previous.history, { at: this.at, value: subscribers }].slice(-MAX_HISTORY);
    }
    this.setCommunity(key, next);
  }

  private setCommunity(key: string, stats: CommunityStats): void {
    this.state = { ...this.state, communities: { ...this.state.communities, [key]: stats } };
  }

  // --- plumbing --------------------------------------------------------------

  /** fetch runs one request script, paced like a person clicking through, and
   *  turns what would end the pass — a refusal, an unreachable site, a spent
   *  rate limit — into the matching error. Anything else is the caller's to
   *  judge. */
  private async fetch<T extends FetchMeta>(script: string, label: string): Promise<T> {
    this.checkStop();
    if (this.remaining !== null && this.remaining < RATE_FLOOR) throw new RateLimited();
    if (this.summary.requests > 0) await this.sleep(this.pause(700, 1800));
    this.checkStop();
    const started = this.now();
    const result = await this.browser.evaluate<T>(script, label);
    this.summary.requests += 1;
    this.log("request", {
      label,
      path: result.path,
      status: result.status,
      ok: result.ok,
      ms: this.now() - started,
      ...(result.refused ? { refused: result.refused } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.ratelimit_remaining !== null ? { ratelimit_remaining: result.ratelimit_remaining } : {}),
    });
    if (result.ratelimit_remaining !== null) this.remaining = result.ratelimit_remaining;
    if (result.status === 429) throw new RateLimited();
    const refused = refusal(result);
    if (refused) throw new Blocked(refused);
    return result;
  }

  /** finish settles the sources and the seen list. A source that is no longer
   *  configured is forgotten, so adding it back starts a fresh baseline. The
   *  inbox is kept while the profile is signed out, so the same account picks
   *  up where it left off after a sign-in. */
  private finish(plan: PlannedSource[]): void {
    const planned = new Set(plan.map((source) => source.key));
    const sources: Record<string, SourceState> = {};
    for (const [key, value] of Object.entries(this.state.sources)) {
      const keep = planned.has(key) || (key === "inbox" && !this.summary.signedIn) || (plan.length === 0 && this.isConfigured(key));
      if (keep) sources[key] = value;
    }
    Object.assign(sources, this.sources);
    const configured = new Set(this.state.settings.communities.map((name) => name.toLowerCase()));
    const communities = Object.fromEntries(Object.entries(this.state.communities).filter(([key]) => configured.has(key)));
    this.state = {
      ...this.state,
      sources,
      communities,
      seen: this.seenOrder.slice(-MAX_SEEN),
      lastPass: {
        at: this.at,
        finishedAt: this.now(),
        newItems: this.summary.newItems,
        urgent: this.summary.urgent,
        countChanges: this.summary.countChanges,
        notes: this.summary.notes,
      },
    };
  }

  /** isConfigured tells a source the settings still ask for, for a pass that
   *  ended before it planned anything. */
  private isConfigured(key: string): boolean {
    if (key === "inbox") return true;
    const settings = this.state.settings;
    if (key.startsWith("search:")) return settings.searchAll;
    const community = /^r\/([^:]+):/.exec(key)?.[1];
    return !!community && settings.communities.some((name) => name.toLowerCase() === community);
  }

  /** park leaves the tab on a blank page. It is best effort. */
  private async park(): Promise<void> {
    if (!this.state.settings.parkTab) return;
    try {
      await this.browser.open(BLANK_PAGE);
    } catch (error) {
      this.log("park_failed", { error: errorText(error) });
    }
  }

  private pause(min: number, max: number): number {
    return Math.round(min + (max - min) * this.random());
  }

  private emit(event: MonitorEvent): void {
    this.events.push(event);
    this.log("event", { event });
    try {
      this.deps.onEvent?.(event);
    } catch (error) {
      this.log("on_event_failed", { error: errorText(error) });
    }
  }

  private step(step: string): void {
    this.log("step", { step });
    try {
      this.deps.onStep?.(step);
    } catch {
      /* a status line is not worth a pass */
    }
  }

  private note(note: string): void {
    if (this.summary.notes.includes(note)) return;
    this.summary.notes = [...this.summary.notes, note].slice(-MAX_PASS_NOTES);
  }

  private checkStop(): void {
    if (this.deps.shouldStop?.()) throw new StopRequested("stopped");
  }
}
