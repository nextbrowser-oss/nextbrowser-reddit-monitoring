// Monitor state and settings: one JSON document the caller owns and persists.
//
// A pass takes the state in and hands the next one back without mutating what
// it was given, as the X monitor and the app's reply engine do, so a pass cut
// short leaves the last saved state intact and everything a finished pass
// learned is in what it returned.

import { MAX_KEYWORDS, normalizeKeywords } from "./keywords.js";
import { DEFAULT_URGENT_TERMS } from "./triage.js";

export interface MonitorSettings {
  /** Words and phrases to find: a brand, a product, a competitor. */
  keywords: string[];
  /** Words that drop an item even when a keyword matched: "hiring",
   *  "giveaway", a namesake that is not you. */
  excludeKeywords: string[];
  /** Communities read on every pass, without the r/. With keywords set, only
   *  their posts and comments that match are reported; without, every new
   *  post is. */
  communities: string[];
  /** Search all of Reddit for the keywords, newest first. Reddit's search
   *  covers posts, not comments. */
  searchAll: boolean;
  /** Read the watched communities' newest comments too, for keyword matches.
   *  Only with keywords: every comment of a busy community is not news. */
  watchComments: boolean;
  /** Read the account's inbox for mentions, replies and private messages.
   *  Needs a signed-in profile. Nothing is marked as read. */
  watchInbox: boolean;
  /** Terms that make an item urgent; see triage.ts. */
  urgentTerms: string[];
  /** How many entries one listing request asks for, 1–100. */
  itemLimit: number;
  /** How old an item may be and still be announced. A monitor that was away
   *  comes back to a day it never saw, and announcing all of it at once is
   *  noise, not news. 0 turns the limit off. */
  maxItemAgeMs: number;
  /** Track the signed-in account's karma. It comes with the identity read,
   *  so it costs no request of its own. */
  trackKarma: boolean;
  /** Track the watched communities' subscriber counts. One request each. */
  trackSubscribers: boolean;
  /** How often one community's count is read. 0 reads it on every pass, for
   *  a host whose own schedule already sets how often that is. */
  countsIntervalMs: number;
  /** Leave the tab on about:blank after a pass. */
  parkTab: boolean;
}

export interface AccountState {
  handle?: string;
  signedIn: boolean;
  checkedAt: number;
}

/** One listing the monitor reads: the inbox, a community's posts or comments,
 *  or one search query. */
export interface SourceState {
  /** When the source was first read with its current filter: nothing created
   *  before it is announced. */
  since: number;
  /** The keyword set the source filtered by when `since` was set. A new set
   *  finds other things in the same listing, so it starts a new baseline
   *  instead of announcing a day of old matches. */
  filter: string;
  lastReadAt?: number;
  lastNewAt?: number;
  /** Why the last read came back with nothing to go on. */
  note?: string;
}

export interface CountSample {
  at: number;
  value: number;
}

export interface KarmaStats {
  /** The account the karma belongs to. */
  owner: string;
  total?: number;
  post?: number;
  comment?: number;
  checkedAt?: number;
  changedAt?: number;
  /** Every change of the total, oldest first, bounded. */
  history: CountSample[];
}

export interface CommunityStats {
  /** As reddit.com spells it. */
  name: string;
  subscribers?: number;
  /** People reading it when it was last checked, as reddit.com rounds it. */
  active?: number;
  checkedAt?: number;
  attemptedAt?: number;
  changedAt?: number;
  history: CountSample[];
  note?: string;
}

export interface PassRecord {
  at: number;
  finishedAt: number;
  newItems: number;
  /** New items triaged as high urgency. */
  urgent: number;
  countChanges: number;
  notes: string[];
}

export interface MonitorState {
  version: 1;
  settings: MonitorSettings;
  account?: AccountState;
  /** Keyed by source: "inbox", "r/<name>:posts", "r/<name>:comments",
   *  "search:<query>". */
  sources: Record<string, SourceState>;
  /** Fullnames already seen or announced, newest last, bounded. One set for
   *  every source, so an item found both in a community and in a search is
   *  announced once. */
  seen: string[];
  karma?: KarmaStats;
  /** Keyed by lowercased community name. */
  communities: Record<string, CommunityStats>;
  lastPass?: PassRecord;
}

export const DEFAULT_ITEM_LIMIT = 25;
export const MAX_ITEM_LIMIT = 100;
export const DEFAULT_MAX_ITEM_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_COUNTS_INTERVAL_MS = 30 * 60 * 1000;
/** Reading one community's count more often than this is not monitoring. */
export const MIN_COUNTS_INTERVAL_MS = 5 * 60 * 1000;
/** How soon a count read that failed is tried again, at most. */
export const COUNTS_RETRY_MS = 10 * 60 * 1000;
export const MAX_COMMUNITIES = 25;
export const MAX_URGENT_TERMS = 50;
export const MAX_SEEN = 3000;
export const MAX_HISTORY = 200;
export const MAX_PASS_NOTES = 5;

/** Reddit community names: letters, digits and underscores, 2–21 long. */
const COMMUNITY = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;
/** Reddit usernames: letters, digits, _ and -, 3–20 long. */
const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;

export function defaultSettings(): MonitorSettings {
  return {
    keywords: [],
    excludeKeywords: [],
    communities: [],
    searchAll: true,
    watchComments: true,
    watchInbox: true,
    urgentTerms: [...DEFAULT_URGENT_TERMS],
    itemLimit: DEFAULT_ITEM_LIMIT,
    maxItemAgeMs: DEFAULT_MAX_ITEM_AGE_MS,
    trackKarma: true,
    trackSubscribers: true,
    countsIntervalMs: DEFAULT_COUNTS_INTERVAL_MS,
    parkTab: true,
  };
}

export function emptyState(settings: Partial<MonitorSettings> = {}): MonitorState {
  return { version: 1, settings: normalizeSettings(settings), sources: {}, seen: [], communities: {} };
}

/** normalizeCommunity accepts "r/webdev", "/r/webdev/", a community URL or a
 *  bare name, and returns the name, or "" for anything that cannot be one. */
export function normalizeCommunity(value: unknown): string {
  let text = String(value ?? "").trim();
  text = text.replace(/^https?:\/\/(?:[a-z]+\.)?reddit\.com/i, "");
  text = text.replace(/^\/?r\//i, "").replace(/\/.*$/, "");
  return COMMUNITY.test(text) ? text : "";
}

/** normalizeUsername strips a u/ and returns "" for anything that cannot be a
 *  Reddit username. */
export function normalizeUsername(value: unknown): string {
  const text = String(value ?? "").trim().replace(/^\/?u(?:ser)?\//i, "");
  return USERNAME.test(text) ? text : "";
}

function integer(value: unknown, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSettings(raw: unknown): MonitorSettings {
  const base = defaultSettings();
  const record = raw && typeof raw === "object" ? (raw as Partial<MonitorSettings>) : {};
  const communities: string[] = [];
  for (const value of Array.isArray(record.communities) ? record.communities : []) {
    const name = normalizeCommunity(value);
    if (name && !communities.some((known) => known.toLowerCase() === name.toLowerCase())) communities.push(name);
  }
  return {
    keywords: normalizeKeywords(record.keywords, MAX_KEYWORDS),
    excludeKeywords: normalizeKeywords(record.excludeKeywords, MAX_KEYWORDS),
    communities: communities.slice(0, MAX_COMMUNITIES),
    searchAll: flag(record.searchAll, base.searchAll),
    watchComments: flag(record.watchComments, base.watchComments),
    watchInbox: flag(record.watchInbox, base.watchInbox),
    urgentTerms: Array.isArray(record.urgentTerms) ? normalizeKeywords(record.urgentTerms, MAX_URGENT_TERMS) : base.urgentTerms,
    itemLimit: integer(record.itemLimit, base.itemLimit, 1, MAX_ITEM_LIMIT),
    maxItemAgeMs: integer(record.maxItemAgeMs, base.maxItemAgeMs, 0),
    trackKarma: flag(record.trackKarma, base.trackKarma),
    trackSubscribers: flag(record.trackSubscribers, base.trackSubscribers),
    countsIntervalMs: record.countsIntervalMs === 0
      ? 0
      : integer(record.countsIntervalMs, base.countsIntervalMs, MIN_COUNTS_INTERVAL_MS),
    parkTab: flag(record.parkTab, base.parkTab),
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function history(raw: unknown): CountSample[] {
  return Array.isArray(raw)
    ? raw
      .filter((sample) => sample && finite(sample.at) !== undefined && finite(sample.value) !== undefined)
      .map((sample) => ({ at: sample.at as number, value: sample.value as number }))
      .slice(-MAX_HISTORY)
    : [];
}

/** normalizeState accepts whatever was on disk, including a file from an
 *  older version or a hand edit, and returns something a pass can run on. */
export function normalizeState(raw: unknown): MonitorState {
  const record = raw && typeof raw === "object" ? (raw as Partial<MonitorState>) : {};
  const state = emptyState(record.settings ?? {});

  const account = record.account;
  if (account && typeof account === "object") {
    const handle = normalizeUsername(account.handle);
    state.account = { ...(handle ? { handle } : {}), signedIn: account.signedIn === true, checkedAt: finite(account.checkedAt) ?? 0 };
  }

  for (const [key, value] of Object.entries(record.sources ?? {})) {
    if (!value || typeof value !== "object" || finite(value.since) === undefined) continue;
    state.sources[key] = {
      since: value.since,
      filter: typeof value.filter === "string" ? value.filter : "",
      ...optional("lastReadAt", finite(value.lastReadAt)),
      ...optional("lastNewAt", finite(value.lastNewAt)),
      ...optional("note", text(value.note)),
    };
  }

  state.seen = Array.isArray(record.seen)
    ? record.seen.filter((key): key is string => typeof key === "string" && !!key).slice(-MAX_SEEN)
    : [];

  const karma = record.karma;
  if (karma && typeof karma === "object" && normalizeUsername(karma.owner)) {
    state.karma = {
      owner: normalizeUsername(karma.owner),
      ...optional("total", finite(karma.total)),
      ...optional("post", finite(karma.post)),
      ...optional("comment", finite(karma.comment)),
      ...optional("checkedAt", finite(karma.checkedAt)),
      ...optional("changedAt", finite(karma.changedAt)),
      history: history(karma.history),
    };
  }

  for (const [key, value] of Object.entries(record.communities ?? {})) {
    if (!value || typeof value !== "object") continue;
    const name = normalizeCommunity(value.name ?? key);
    if (!name) continue;
    state.communities[name.toLowerCase()] = {
      name,
      ...optional("subscribers", finite(value.subscribers)),
      ...optional("active", finite(value.active)),
      ...optional("checkedAt", finite(value.checkedAt)),
      ...optional("attemptedAt", finite(value.attemptedAt)),
      ...optional("changedAt", finite(value.changedAt)),
      history: history(value.history),
      ...optional("note", text(value.note)),
    };
  }

  const pass = record.lastPass;
  if (pass && typeof pass === "object" && finite(pass.at) !== undefined) {
    state.lastPass = {
      at: pass.at,
      finishedAt: finite(pass.finishedAt) ?? pass.at,
      newItems: finite(pass.newItems) ?? 0,
      urgent: finite(pass.urgent) ?? 0,
      countChanges: finite(pass.countChanges) ?? 0,
      notes: Array.isArray(pass.notes) ? pass.notes.filter((note): note is string => typeof note === "string").slice(-MAX_PASS_NOTES) : [],
    };
  }
  return state;
}

/** withSettings applies a settings patch, normalized. */
export function withSettings(state: MonitorState, patch: Partial<MonitorSettings>): MonitorState {
  return { ...state, settings: normalizeSettings({ ...state.settings, ...patch }) };
}

/** countsDue says whether a community's count is due for a read. A read that
 *  failed is retried sooner than the interval, but not on every pass. */
export function countsDue(state: MonitorState, community: string, at: number): boolean {
  const stats = state.communities[community.toLowerCase()];
  const interval = state.settings.countsIntervalMs;
  if (stats?.checkedAt !== undefined && at - stats.checkedAt < interval) return false;
  if (stats?.attemptedAt !== undefined && at - stats.attemptedAt < Math.min(interval, COUNTS_RETRY_MS)) return false;
  return true;
}
