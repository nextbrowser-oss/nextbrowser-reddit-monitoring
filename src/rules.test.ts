// The pure rules: keyword matching, urgency triage, items, and the state
// document. Everything here is what a person would check before trusting the
// monitor with their account, so every rule has a case of its own.

import { describe, expect, it } from "vitest";
import { normalizeItems, type RedditItem } from "./items.js";
import { keywordMatcher, normalizeKeyword, normalizeKeywords, searchQueries, signature, splitKeywords } from "./keywords.js";
import { scheduleDelay } from "./schedule.js";
import { countsDue, emptyState, normalizeCommunity, normalizeSettings, normalizeState, normalizeUsername } from "./state.js";
import { DEFAULT_URGENT_TERMS, byUrgency, triage } from "./triage.js";
import { NOON, mention, post } from "./testing/fakeBrowser.js";

describe("keywords", () => {
  it("match whole words and phrases, in any case and any script", () => {
    const match = keywordMatcher(["nextbrowser", "next browser", "браузер", "c++", ".net"]);
    expect(match("Anyone tried NextBrowser?")).toEqual(["nextbrowser"]);
    expect(match("see nextbrowser.com")).toEqual(["nextbrowser"]);
    expect(match("the next\n browser war")).toEqual(["next browser"]);
    expect(match("nextbrowsers are everywhere")).toEqual([]);
    expect(match("Какой браузер выбрать?")).toEqual(["браузер"]);
    expect(match("браузеры")).toEqual([]);
    expect(match("I write C++ and .NET")).toEqual(["c++", ".net"]);
  });

  it("are normalized as a person types them", () => {
    expect(normalizeKeyword('  "Next   Browser"  ')).toBe("Next Browser");
    expect(normalizeKeyword("x")).toBe("");
    expect(normalizeKeywords(["Nextbrowser", "nextbrowser", "", "ok"])).toEqual(["Nextbrowser", "ok"]);
    expect(splitKeywords("nextbrowser, next browser\nnbc")).toEqual(["nextbrowser", "next browser", "nbc"]);
  });

  it("go into a few OR searches, phrases quoted", () => {
    expect(searchQueries(["a1", "b2", "c 3", "d4", "e5", "f6"])).toEqual(['a1 OR b2 OR "c 3" OR d4 OR e5', "f6"]);
  });

  it("have a signature that ignores order and case", () => {
    expect(signature(["B", "a"])).toBe(signature(["A", "b"]));
  });
});

const at = NOON + 60 * 60_000;
const urgent = keywordMatcher([...DEFAULT_URGENT_TERMS]);
const item = (raw: ReturnType<typeof post>, inbox = false): RedditItem => normalizeItems([raw], { inbox })[0]!;
const rank = (value: RedditItem, keywords: string[] = []) => triage(value, { at, keywords, urgent });

describe("triage", () => {
  it("puts what is addressed to the account on top", () => {
    expect(rank(item(mention(50, "u/acme_team thoughts?"), true))).toEqual({ urgency: "high", score: 5, reasons: ["Mentions you", "Asks a question"] });
    expect(rank(item(mention(50, "thanks!", { type: "comment_reply" }), true)).reasons).toEqual(["Replies to your comment"]);
  });

  it("ranks a complaint high and says why", () => {
    const complaint = item(post("webdev", 50, "Nextbrowser charged me twice, need a refund", { comments: 2 }));
    expect(rank(complaint, ["nextbrowser"])).toEqual({ urgency: "high", score: 4, reasons: ['Says "refund", "charged"', '"nextbrowser" is in the title'] });
  });

  it("ranks an unanswered question about a keyword medium", () => {
    const question = item(post("webdev", 50, "How does Nextbrowser handle proxies?", { comments: 0 }));
    expect(rank(question, ["nextbrowser"])).toEqual({ urgency: "medium", score: 3, reasons: ["Asks a question", '"nextbrowser" is in the title', "No replies yet"] });
  });

  it("ranks a passing mention low", () => {
    const passing = item(post("webdev", 50, "My setup", { text: "I also use nextbrowser sometimes." }));
    expect(rank(passing, ["nextbrowser"])).toEqual({ urgency: "low", score: 0, reasons: [] });
  });

  it("notices a post picking up fast", () => {
    const busy = item(post("webdev", 0, "My setup", { comments: 40 }));
    expect(rank(busy).reasons).toEqual(["40 comments in 1 hour"]);
  });

  it("sorts most urgent first, then newest", () => {
    const entries = [
      { item: item(post("a", 10, "low old")), triage: { urgency: "low" as const, score: 0, reasons: [] } },
      { item: item(post("a", 20, "high")), triage: { urgency: "high" as const, score: 4, reasons: [] } },
      { item: item(post("a", 30, "low new")), triage: { urgency: "low" as const, score: 0, reasons: [] } },
    ];
    expect(entries.sort(byUrgency).map((entry) => entry.item.title)).toEqual(["high", "low new", "low old"]);
  });
});

describe("items", () => {
  it("become absolute links, milliseconds, and drop what was removed", () => {
    const items = normalizeItems([
      post("webdev", 0, "kept"),
      post("webdev", 1, "gone", { removed: true }),
      { ...post("webdev", 2, "no id"), id: "" },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "post", url: expect.stringMatching(/^https:\/\/www\.reddit\.com\/r\/webdev\/comments\//), createdAt: NOON });
  });

  it("say why an inbox item is there only when read from the inbox", () => {
    expect(normalizeItems([mention(0, "hi")], { inbox: true })[0]!.addressed).toBe("mention");
    expect(normalizeItems([mention(0, "hi")])[0]!.addressed).toBeUndefined();
  });
});

describe("state", () => {
  it("reads community names in every form a person pastes them", () => {
    for (const value of ["webdev", "r/webdev", "/r/webdev/", "https://www.reddit.com/r/webdev/comments/abc", "https://old.reddit.com/r/webdev"]) {
      expect(normalizeCommunity(value), value).toBe("webdev");
    }
    expect(normalizeCommunity("not a name!")).toBe("");
    expect(normalizeUsername("u/acme_team")).toBe("acme_team");
    expect(normalizeUsername("x")).toBe("");
  });

  it("clamps settings to safe ranges", () => {
    const settings = normalizeSettings({ itemLimit: 5000, countsIntervalMs: 1000, communities: ["a!", "webdev", "WEBDEV"], keywords: ["ok", "ok"] });
    expect(settings).toMatchObject({ itemLimit: 100, countsIntervalMs: 5 * 60_000, communities: ["webdev"], keywords: ["ok"] });
    expect(normalizeSettings({ countsIntervalMs: 0 }).countsIntervalMs).toBe(0);
    // An empty urgent list is a choice; a missing one is the default.
    expect(normalizeSettings({ urgentTerms: [] }).urgentTerms).toEqual([]);
    expect(normalizeSettings({}).urgentTerms).toEqual(DEFAULT_URGENT_TERMS);
  });

  it("accepts whatever was on disk", () => {
    expect(normalizeState(null)).toEqual(emptyState());
    const state = normalizeState({
      account: { handle: "acme_team", signedIn: true, checkedAt: 5 },
      sources: { inbox: { since: 1, filter: "" }, broken: { filter: "x" } },
      seen: ["t3_a", 5, ""],
      communities: { webdev: { subscribers: 10, history: [{ at: 1, value: 10 }, { at: "x" }] } },
      lastPass: { at: 9, notes: ["n", 3] },
    });
    expect(Object.keys(state.sources)).toEqual(["inbox"]);
    expect(state.seen).toEqual(["t3_a"]);
    expect(state.communities.webdev).toMatchObject({ name: "webdev", subscribers: 10, history: [{ at: 1, value: 10 }] });
    expect(state.lastPass).toMatchObject({ at: 9, finishedAt: 9, newItems: 0, notes: ["n"] });
  });

  it("says when a community's count is due", () => {
    const state = normalizeState({ settings: { countsIntervalMs: 30 * 60_000 }, communities: { webdev: { checkedAt: 0, attemptedAt: 0, history: [] } } });
    expect(countsDue(state, "webdev", 10 * 60_000)).toBe(false);
    expect(countsDue(state, "webdev", 31 * 60_000)).toBe(true);
    expect(countsDue(state, "other", 0)).toBe(true);
  });
});

describe("scheduleDelay", () => {
  it("spreads the interval, never goes under a minute, and backs off after a refusal", () => {
    expect(scheduleDelay(10 * 60_000, { random: () => 0.5 })).toBe(10 * 60_000);
    expect(scheduleDelay(10 * 60_000, { random: () => 0 })).toBe(8 * 60_000);
    expect(scheduleDelay(1000, { random: () => 0 })).toBe(60_000);
    expect(scheduleDelay(10 * 60_000, { random: () => 0.5, backOff: true })).toBe(30 * 60_000);
  });
});
