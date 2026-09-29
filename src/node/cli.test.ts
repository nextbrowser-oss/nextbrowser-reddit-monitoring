import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PassSummary } from "../engine.js";
import { emptyState } from "../state.js";
import { describeEvent, describePass, parseDuration, settingsFromFlags } from "./cli.js";
import { loadState, saveState } from "./store.js";

describe("parseDuration", () => {
  it("reads the durations the flags take", () => {
    expect(parseDuration("90s", "--x")).toBe(90_000);
    expect(parseDuration("10m", "--x")).toBe(600_000);
    expect(parseDuration("1.5h", "--x")).toBe(5_400_000);
    expect(parseDuration("45", "--x")).toBe(45_000);
    expect(() => parseDuration("soon", "--interval")).toThrow("--interval");
  });
});

describe("settingsFromFlags", () => {
  it("patches only what was given, and the negative flag wins", () => {
    expect(settingsFromFlags({})).toEqual({});
    expect(settingsFromFlags({ "no-search": true, search: true, comments: true, "no-inbox": true, "no-karma": true, "keep-tab": true })).toEqual({
      searchAll: false,
      watchComments: true,
      watchInbox: false,
      trackKarma: false,
      parkTab: false,
    });
    expect(settingsFromFlags({ keywords: "nextbrowser, next browser", exclude: "hiring", communities: "r/webdev, SaaS", "max-age": "6h", limit: "50" })).toEqual({
      keywords: ["nextbrowser", "next browser"],
      excludeKeywords: ["hiring"],
      communities: ["webdev", "SaaS"],
      maxItemAgeMs: 6 * 3_600_000,
      itemLimit: 50,
    });
  });

  it("refuses a community name Reddit would not have", () => {
    expect(() => settingsFromFlags({ communities: "webdev, not a name!" })).toThrow("not a community name");
  });
});

describe("describeEvent", () => {
  const at = new Date(2026, 8, 29, 9, 5).getTime();

  it("writes a match on two lines: what and how urgent, then why and where", () => {
    const line = describeEvent({
      type: "new_item",
      at,
      source: { kind: "community", name: "r/webdev" },
      keywords: ["nextbrowser"],
      triage: { urgency: "high", score: 4, reasons: ['Says "refund"', '"nextbrowser" is in the title'] },
      item: { key: "t3_a", id: "a", kind: "post", subreddit: "webdev", author: "alice", title: "Nextbrowser refund?", text: "", url: "https://www.reddit.com/r/webdev/comments/a/", nsfw: false },
    });
    expect(line).toBe('09:05  HIGH    r/webdev  u/alice: "Nextbrowser refund?"\n        [Says "refund" · "nextbrowser" is in the title]  https://www.reddit.com/r/webdev/comments/a/');
  });

  it("says who addressed the account", () => {
    const line = describeEvent({
      type: "new_item",
      at,
      source: { kind: "inbox", name: "inbox" },
      keywords: [],
      triage: { urgency: "high", score: 4, reasons: ["Mentions you"] },
      item: { key: "t1_b", id: "b", kind: "comment", subreddit: "webdev", author: "bob", title: "Tools", text: "u/acme_team thoughts?", url: "https://www.reddit.com/b", nsfw: false, addressed: "mention" },
    });
    expect(line).toContain("inbox  u/bob mentioned you: u/acme_team thoughts?");
    expect(describeEvent({ type: "karma_changed", at, handle: "acme_team", previous: 150, current: 180, delta: 30 })).toBe("09:05  karma u/acme_team: 150 → 180 (+30)");
    expect(describeEvent({ type: "subscribers_changed", at, community: "webdev", previous: 1000, current: 990, delta: -10 })).toMatch(/subscribers r\/webdev: 1,000 → 990 \(-10\)$/);
  });
});

describe("describePass", () => {
  const summary: PassSummary = {
    signedIn: true, handle: "acme_team", loginRequired: false, rateLimited: false, requests: 7, sourcesRead: 4, baselines: 0,
    itemsRead: 80, matches: 9, newItems: 3, urgent: 1, countChecks: 2, countChanges: 1, stopped: false, notes: [],
  };

  it("sums a pass up in one line, in 24-hour time", () => {
    expect(describePass(summary, new Date(2026, 8, 29, 21, 5).getTime()))
      .toBe("21:05  pass u/acme_team: 4 sources: 3 new (1 urgent) of 9 matches; counts: 2 read, 1 changed");
  });

  it("calls a first pass the starting line, and puts the notes under it", () => {
    const line = describePass({ ...summary, baselines: 4, notes: ["r/secret is private."] }, new Date(2026, 8, 29, 9, 0).getTime());
    expect(line).toBe("09:00  pass u/acme_team: starting line: 4 sources, 9 matches; counts: 2 read, 1 changed\n        r/secret is private.");
  });
});

describe("the state file", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("round-trips, and a missing file is a fresh state", async () => {
    dir = await mkdtemp(join(tmpdir(), "reddit-monitor-"));
    const path = join(dir, "nested", "state.json");
    expect(await loadState(path)).toEqual(emptyState());
    const state = { ...emptyState({ keywords: ["nextbrowser"] }), seen: ["t3_a"], sources: { inbox: { since: 5, filter: "" } } };
    await saveState(path, state);
    expect(await loadState(path)).toEqual(state);
    expect(JSON.parse(await readFile(path, "utf8")).settings.keywords).toEqual(["nextbrowser"]);
  });

  it("refuses a file it cannot read rather than starting over", async () => {
    dir = await mkdtemp(join(tmpdir(), "reddit-monitor-"));
    const path = join(dir, "state.json");
    await writeFile(path, "{ not json");
    await expect(loadState(path)).rejects.toThrow();
  });
});
