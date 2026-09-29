import { beforeEach, describe, expect, it } from "vitest";
import { checkAccount, runPass, type PassDeps, type PassResult } from "./engine.js";
import type { MonitorEvent, NewItemEvent } from "./events.js";
import type { RedditItem } from "./items.js";
import { LANDING_URL, SIGN_IN_URL } from "./scripts.js";
import { emptyState, withSettings, type MonitorSettings, type MonitorState } from "./state.js";
import { FakeReddit, NOON, comment, mention, post } from "./testing/fakeBrowser.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let clock = NOON + 60 * MINUTE;
let reddit: FakeReddit;

beforeEach(() => {
  clock = NOON + 60 * MINUTE;
  reddit = new FakeReddit();
  reddit.communities.webdev = { posts: [], comments: [], subscribers: 1000 };
});

function pass(state: MonitorState, extra: Partial<PassDeps> = {}): Promise<PassResult> {
  return runPass({
    browser: reddit,
    state,
    now: () => clock,
    // Waiting is instant, but the clock moves, so pauses still take time.
    sleep: async (ms) => {
      clock += ms;
    },
    random: () => 0.5,
    ...extra,
  });
}

function watching(patch: Partial<MonitorSettings> = {}): MonitorState {
  return emptyState({ keywords: ["nextbrowser"], communities: ["webdev"], ...patch });
}

const types = (events: MonitorEvent[]) => events.map((event) => event.type);
const fresh = (events: MonitorEvent[]) => events.filter((event): event is NewItemEvent => event.type === "new_item");
/** What a person would call an item: a post by its title, anything else by
 *  what it says. */
const label = (item: RedditItem) => (item.kind === "post" ? item.title : item.text);
const titles = (events: MonitorEvent[]) => fresh(events).map((event) => label(event.item));

/** later moves the clock on to the next pass and returns a minute offset from
 *  NOON that lies between the two passes. */
function later(minutes = 10): number {
  const between = (clock - NOON) / MINUTE + 1;
  clock += minutes * MINUTE;
  return between;
}

describe("the first pass", () => {
  it("signs in, records every source as its starting line, and announces nothing", async () => {
    reddit.inbox = [mention(30, "hey u/acme_team")];
    reddit.communities.webdev!.posts = [post("webdev", 40, "Is Nextbrowser any good?"), post("webdev", 35, "Unrelated")];
    reddit.searchResults = [post("SaaS", 20, "Tried nextbrowser today")];
    const { state, events, summary, matches } = await pass(watching());

    expect(types(events)).toEqual(["signed_in"]);
    expect(summary).toMatchObject({ signedIn: true, handle: "acme_team", baselines: 4, sourcesRead: 4, newItems: 0 });
    expect(reddit.listings).toEqual(["inbox", "r/webdev:posts", "r/webdev:comments", "search:nextbrowser"]);
    // The dashboard still gets what was found: the mention and both matches.
    expect(matches.map((match) => label(match.item)).sort()).toEqual(["Is Nextbrowser any good?", "Tried nextbrowser today", "hey u/acme_team"]);
    expect(Object.keys(state.sources).sort()).toEqual(["inbox", "r/webdev:comments", "r/webdev:posts", "search:nextbrowser"]);
    expect(state.karma).toMatchObject({ owner: "acme_team", total: 150, post: 100, comment: 50, history: [{ value: 150 }] });
    expect(state.communities.webdev).toMatchObject({ subscribers: 1000, history: [{ value: 1000 }] });
    // It lands on the lightest reddit.com page and leaves the tab blank.
    expect(reddit.opened).toEqual([LANDING_URL, "about:blank"]);
  });

  it("never mutates the state it was given", async () => {
    reddit.communities.webdev!.posts = [post("webdev", 40, "nextbrowser")];
    const given = watching();
    const copy = structuredClone(given);
    await pass(Object.freeze(given));
    expect(given).toEqual(copy);
  });

  it("says so when there is nothing to watch", async () => {
    const { summary } = await pass(emptyState({ watchInbox: false }));
    expect(summary.notes).toContain("Nothing to watch yet: add keywords or communities.");
    expect(reddit.listings).toEqual([]);
  });
});

describe("what is announced", () => {
  it("announces mentions and keyword matches that appeared since the last pass, source by source", async () => {
    const first = await pass(watching());
    const minute = later();
    reddit.inbox = [mention(minute + 2, "u/acme_team what do you think?")];
    reddit.communities.webdev!.posts = [
      post("webdev", minute + 3, "Nextbrowser keeps crashing on login", { comments: 0 }),
      post("webdev", minute + 1, "Something else entirely"),
    ];
    reddit.communities.webdev!.comments = [comment("webdev", minute, "I switched to nextbrowser last week")];
    const { events, summary } = await pass(first.state);

    expect(titles(events)).toEqual(["u/acme_team what do you think?", "Nextbrowser keeps crashing on login", "I switched to nextbrowser last week"]);
    const [inbox, complaint, remark] = fresh(events);
    expect(inbox).toMatchObject({ account: "acme_team", source: { kind: "inbox" }, keywords: [], item: { addressed: "mention" } });
    expect(inbox!.triage.urgency).toBe("high");
    expect(remark).toMatchObject({ source: { kind: "community", name: "r/webdev" }, keywords: ["nextbrowser"], triage: { urgency: "low" } });
    expect(complaint!.triage).toEqual({ urgency: "high", score: 5, reasons: ['Says "crashing"', '"nextbrowser" is in the title', "No replies yet"] });
    expect(summary).toMatchObject({ newItems: 3, urgent: 2, baselines: 0 });
  });

  it("reports an item found in a community and in the search once", async () => {
    const first = await pass(watching());
    const minute = later();
    const both = post("webdev", minute, "nextbrowser 2.0 is out");
    reddit.communities.webdev!.posts = [both];
    reddit.searchResults = [both];
    const { events } = await pass(first.state);
    expect(fresh(events)).toHaveLength(1);
    expect(fresh(events)[0]!.source.kind).toBe("community");
  });

  it("matches search results again: Reddit's search is fuzzier than a keyword", async () => {
    const first = await pass(watching());
    const minute = later();
    reddit.searchResults = [post("SaaS", minute, "Best browsers for nextjs"), post("SaaS", minute + 1, "Nextbrowser vs the rest")];
    const { events } = await pass(first.state);
    expect(titles(events)).toEqual(["Nextbrowser vs the rest"]);
  });

  it("leaves out excluded words, the account's own posts, and anything older than the starting line", async () => {
    const first = await pass(watching({ excludeKeywords: ["hiring"] }));
    const minute = later();
    reddit.communities.webdev!.posts = [
      post("webdev", minute, "Hiring: nextbrowser engineer"),
      post("webdev", minute + 1, "We shipped nextbrowser 2", { author: "acme_team" }),
      post("webdev", 5, "nextbrowser, from before the monitor started"),
      post("webdev", minute + 2, "nextbrowser question"),
    ];
    const { events } = await pass(first.state);
    expect(titles(events)).toEqual(["nextbrowser question"]);
  });

  it("does not announce the same item twice", async () => {
    const first = await pass(watching());
    const minute = later();
    reddit.communities.webdev!.posts = [post("webdev", minute, "nextbrowser")];
    const second = await pass(first.state);
    later();
    const third = await pass(second.state);
    expect(fresh(second.events)).toHaveLength(1);
    expect(fresh(third.events)).toHaveLength(0);
  });

  it("does not announce a day of news after a long absence", async () => {
    const first = await pass(watching({ maxItemAgeMs: 6 * HOUR }));
    const minute = later(20 * 60);
    reddit.communities.webdev!.posts = [post("webdev", minute + 60, "nextbrowser, while asleep"), post("webdev", minute + 19 * 60, "nextbrowser, just now")];
    const { events } = await pass(first.state);
    expect(titles(events)).toEqual(["nextbrowser, just now"]);
  });
});

describe("communities without keywords", () => {
  it("announces every new post, and reads no comments and no search", async () => {
    const first = await pass(emptyState({ communities: ["webdev"] }));
    const minute = later();
    reddit.communities.webdev!.posts = [post("webdev", minute, "Anything at all")];
    const { events } = await pass(first.state);
    expect(titles(events)).toEqual(["Anything at all"]);
    expect(reddit.listings.filter((key) => key !== "inbox")).toEqual(["r/webdev:posts", "r/webdev:posts"]);
  });
});

describe("a change of what is watched", () => {
  it("starts a new keyword set from a fresh starting line instead of announcing old matches", async () => {
    const minute = (clock - NOON) / MINUTE - 20;
    reddit.communities.webdev!.posts = [post("webdev", minute, "Playwright tips")];
    const first = await pass(watching());
    later();
    const { events, summary } = await pass(withSettings(first.state, { keywords: ["nextbrowser", "playwright"] }));
    expect(fresh(events)).toHaveLength(0);
    // The inbox does not filter by keyword and carries on.
    expect(summary.baselines).toBe(3);
  });

  it("forgets a community that was removed, so adding it back starts over", async () => {
    const first = await pass(watching());
    later();
    const without = await pass(withSettings(first.state, { communities: [] }));
    expect(Object.keys(without.state.sources)).not.toContain("r/webdev:posts");
    expect(without.state.communities).toEqual({});
  });
});

describe("the account", () => {
  it("reads communities and search while signed out, and says the inbox waits for a sign-in", async () => {
    const first = await pass(watching());
    reddit.signedIn = false;
    later();
    const out = await pass(first.state);
    expect(types(out.events)).toEqual(["signed_out"]);
    expect(out.summary).toMatchObject({ signedIn: false, loginRequired: true });
    expect(out.state.sources.inbox).toBeDefined();
    expect(reddit.listings.slice(-3)).toEqual(["r/webdev:posts", "r/webdev:comments", "search:nextbrowser"]);

    // Signed in again, the inbox picks up where it left off.
    reddit.signedIn = true;
    const minute = later();
    reddit.inbox = [mention(minute, "u/acme_team hello again")];
    const back = await pass(out.state);
    expect(types(back.events)).toEqual(["signed_in", "new_item"]);
  });

  it("starts the inbox over when another account signs in", async () => {
    reddit.inbox = [mention(30, "old")];
    const first = await pass(watching());
    reddit.handle = "other_account";
    const minute = later();
    reddit.inbox = [mention(minute, "for the other account")];
    const { events } = await pass(first.state);
    expect(types(events)).toEqual(["account_changed"]);
  });

  it("reports karma that moved", async () => {
    const first = await pass(watching());
    reddit.karma = { link: 130, comment: 50 };
    later();
    const { events, state } = await pass(first.state);
    expect(events).toContainEqual(expect.objectContaining({ type: "karma_changed", handle: "acme_team", previous: 150, current: 180, delta: 30, post: 130 }));
    expect(state.karma!.history.map((sample) => sample.value)).toEqual([150, 180]);
  });
});

describe("subscriber counts", () => {
  it("reads a community's count when it is due, and reports a change", async () => {
    const first = await pass(watching());
    reddit.communities.webdev!.subscribers = 1200;
    later(5);
    const early = await pass(first.state);
    expect(reddit.labels.filter((label) => label.startsWith("about")).length).toBe(1);
    later(30);
    const due = await pass(early.state);
    expect(due.events).toContainEqual(expect.objectContaining({ type: "subscribers_changed", community: "webdev", previous: 1000, current: 1200, delta: 200 }));
  });

  it("reads it on every pass with countsIntervalMs 0", async () => {
    const first = await pass(watching({ countsIntervalMs: 0 }));
    later(2);
    await pass(first.state);
    expect(reddit.labels.filter((label) => label.startsWith("about")).length).toBe(2);
  });

  it("notes a private community and goes on with the rest", async () => {
    reddit.communities.secret = { posts: [], comments: [], error: { status: 403, reason: "private" } };
    const { summary, state } = await pass(watching({ communities: ["secret", "webdev"] }));
    expect(summary.notes).toContain("r/secret is private.");
    expect(reddit.listings).toContain("r/webdev:posts");
    expect(state.communities.secret).toMatchObject({ note: "r/secret is private.", attemptedAt: expect.any(Number) });
  });
});

describe("when reddit.com says no", () => {
  it("stops at a refused landing page, reads nothing, and keeps the state", async () => {
    const first = await pass(watching());
    reddit.landingRefused = "You've been blocked by network security.";
    reddit.url = "about:blank";
    later();
    const { summary, state } = await pass(first.state);
    expect(summary.blocked).toContain("blocked by network security");
    expect(summary.requests).toBe(0);
    expect(state.sources).toEqual(first.state.sources);
  });

  it("stops at a refused request, keeping what was read before it", async () => {
    const first = await pass(watching());
    reddit.refuseListing = "r/webdev:comments";
    const minute = later();
    reddit.communities.webdev!.posts = [post("webdev", minute, "nextbrowser")];
    const { summary, events, state } = await pass(first.state);
    expect(summary.blocked).toBe("reddit.com refused the request (HTTP 403: Blocked).");
    expect(fresh(events)).toHaveLength(1);
    expect(state.sources["search:nextbrowser"]).toEqual(first.state.sources["search:nextbrowser"]);
    expect(state.seen).toContain(fresh(events)[0]!.item.key);
    expect(reddit.opened.at(-1)).toBe("about:blank");
  });

  it("stops before the rate limit runs out", async () => {
    reddit.rateLimit = 5;
    const { summary } = await pass(watching());
    expect(summary.rateLimited).toBe(true);
    expect(summary.requests).toBe(3);
  });

  it("stops on a 429", async () => {
    reddit.throttleListing = "inbox";
    const { summary } = await pass(watching());
    expect(summary.rateLimited).toBe(true);
    expect(reddit.listings).toEqual(["inbox"]);
  });

  it("ends a pass that is asked to stop", async () => {
    let asked = 0;
    const { summary } = await pass(watching(), { shouldStop: () => ++asked > 3 });
    expect(summary.stopped).toBe(true);
    expect(reddit.opened.at(-1)).toBe("about:blank");
  });
});

describe("checkAccount", () => {
  it("opens reddit.com, says who is signed in, and leaves the page open", async () => {
    expect(await checkAccount({ browser: reddit })).toEqual({ signedIn: true, handle: "acme_team", karma: 150 });
    expect(reddit.opened).toEqual([SIGN_IN_URL]);
    reddit.signedIn = false;
    expect(await checkAccount({ browser: reddit })).toEqual({ signedIn: false });
  });
});
