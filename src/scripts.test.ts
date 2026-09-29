// @vitest-environment happy-dom
/// <reference lib="dom" />
//
// The page scripts run here against stand-in answers shaped like reddit.com's
// own: listings, /api/me.json signed in and out, about.json, and the refusal
// page it serves a profile it does not trust. A script that does not even
// parse would otherwise only fail inside a browser, on someone's account.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TEXT_MAX,
  aboutScript,
  allScripts,
  communityPostsPath,
  inboxPath,
  listingScript,
  meScript,
  originScript,
  searchPath,
  type AboutSnapshot,
  type ListingSnapshot,
  type MeSnapshot,
  type OriginSnapshot,
} from "./scripts.js";

async function run<T>(script: string): Promise<T> {
  // Indirect eval: the script runs in the page's global scope, as it would in
  // Runtime.evaluate, and comes back through JSON as it would over CDP.
  return JSON.parse(JSON.stringify(await (0, eval)(script))) as T;
}

function page(url: string, text = ""): void {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(url);
  document.body.innerHTML = text;
}

interface Answer {
  status?: number;
  type?: string;
  body: unknown;
  headers?: Record<string, string>;
}

/** answer makes fetch return one response, and records what was asked. */
function answer(response: Answer | ((path: string) => Answer)) {
  const asked: { path: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    asked.push({ path, init });
    const { status = 200, type = "application/json; charset=UTF-8", body, headers = {} } = typeof response === "function" ? response(path) : response;
    const all: Record<string, string> = { "content-type": type, ...headers };
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (name: string) => all[name.toLowerCase()] ?? null },
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const listing = (...children: unknown[]) => ({ kind: "Listing", data: { after: null, children } });

describe("every script", () => {
  it.each(Object.entries(allScripts()))("%s is a single valid expression", (_name, script) => {
    expect(() => new Function(`return ${script};`)).not.toThrow();
  });
});

describe("originScript", () => {
  it("knows reddit.com from anywhere else", async () => {
    page("https://www.reddit.com/api/me.json");
    expect(await run<OriginSnapshot>(originScript())).toMatchObject({ on_reddit: true, refused: "" });
    page("https://old.reddit.com/");
    expect((await run<OriginSnapshot>(originScript())).on_reddit).toBe(true);
    page("https://notreddit.com/");
    expect((await run<OriginSnapshot>(originScript())).on_reddit).toBe(false);
  });

  it("knows reddit.com's refusal page", async () => {
    page("https://www.reddit.com/api/me.json", "<h1>whoa there, pardner!</h1><p>You've been blocked by network security.</p>");
    expect((await run<OriginSnapshot>(originScript())).refused).toContain("blocked by network security");
  });
});

describe("listingScript", () => {
  it("fetches with the profile's cookies and cuts each child down to what the monitor uses", async () => {
    page("https://www.reddit.com/api/me.json");
    const asked = answer({
      body: listing(
        {
          kind: "t3",
          data: {
            id: "1abc", name: "t3_1abc", subreddit: "webdev", author: "alice", title: "Is Nextbrowser any good?",
            selftext: "x".repeat(TEXT_MAX + 500), permalink: "/r/webdev/comments/1abc/is_nextbrowser_any_good/",
            url: "https://www.reddit.com/r/webdev/comments/1abc/", is_self: true, created_utc: 1790690400, score: 12,
            num_comments: 0, link_flair_text: "Question", over_18: false, stickied: false, preview: { images: ["…40 KB…"] },
          },
        },
        {
          kind: "t3",
          data: { id: "2def", name: "t3_2def", subreddit: "SaaS", author: "bob", title: "A link", selftext: "", is_self: false, url: "https://nextbrowser.com/blog", permalink: "/r/SaaS/comments/2def/a_link/", created_utc: 1790690500 },
        },
        { kind: "more", data: {} },
      ),
      headers: { "x-ratelimit-remaining": "95.0", "x-ratelimit-reset": "120" },
    });
    const snapshot = await run<ListingSnapshot>(listingScript(communityPostsPath("webdev", 25)));

    expect(asked[0]).toMatchObject({ path: "/r/webdev/new.json?limit=25&raw_json=1", init: { credentials: "include" } });
    expect(snapshot).toMatchObject({ status: 200, ok: true, refused: "", ratelimit_remaining: 95, ratelimit_reset: 120 });
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]).toMatchObject({
      kind: "t3", name: "t3_1abc", subreddit: "webdev", author: "alice", title: "Is Nextbrowser any good?",
      permalink: "/r/webdev/comments/1abc/is_nextbrowser_any_good/", link_url: "", created: 1790690400, comments: 0, flair: "Question",
    });
    expect(snapshot.items[0]!.text).toHaveLength(TEXT_MAX);
    expect(snapshot.items[0]).not.toHaveProperty("preview");
    expect(snapshot.items[1]!.link_url).toBe("https://nextbrowser.com/blog");
  });

  it("takes an inbox comment's context link and why it is in the inbox", async () => {
    page("https://www.reddit.com/api/me.json");
    answer({
      body: listing(
        {
          kind: "t1",
          data: {
            id: "k1", name: "t1_k1", subreddit: "webdev", author: "carol", body: "u/acme_team any thoughts?", link_title: "Browser tools",
            context: "/r/webdev/comments/abc/browser_tools/k1/?context=3", type: "username_mention", subject: "username mention", new: true, created_utc: 1790690600,
          },
        },
        { kind: "t4", data: { id: "pm1", name: "t4_pm1", author: "dave", subject: "Partnership", body: "Hi!", created_utc: 1790690700, new: false } },
      ),
    });
    const snapshot = await run<ListingSnapshot>(listingScript(inboxPath(25)));
    expect(snapshot.items[0]).toMatchObject({ kind: "t1", title: "Browser tools", permalink: "/r/webdev/comments/abc/browser_tools/k1/?context=3", type: "username_mention", unread: true });
    expect(snapshot.items[1]).toMatchObject({ kind: "t4", title: "Partnership", text: "Hi!", subreddit: "" });
  });

  it("marks what a moderator removed", async () => {
    page("https://www.reddit.com/");
    answer({ body: listing({ kind: "t1", data: { id: "r1", name: "t1_r1", body: "[removed]", author: "[deleted]" } }) });
    expect((await run<ListingSnapshot>(listingScript("/r/x/comments.json"))).items[0]!.removed).toBe(true);
  });

  it("reports reddit.com's refusal page instead of an empty listing", async () => {
    page("https://www.reddit.com/");
    answer({ status: 403, type: "text/html", body: "<html><head><title>Blocked</title></head><body>You've been blocked by network security.</body></html>" });
    const snapshot = await run<ListingSnapshot>(listingScript("/search.json?q=x"));
    expect(snapshot).toMatchObject({ status: 403, ok: false, refused: "Blocked", items: [] });
  });

  it("reports reddit.com's reason on a JSON error", async () => {
    page("https://www.reddit.com/");
    answer({ status: 403, body: { reason: "private", message: "Forbidden", error: 403 } });
    expect(await run<ListingSnapshot>(listingScript("/r/secret/new.json"))).toMatchObject({ status: 403, ok: false, refused: "", reason: "private" });
  });

  it("reports a request that never got an answer", async () => {
    page("https://www.reddit.com/");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await run<ListingSnapshot>(listingScript("/r/x/new.json"))).toMatchObject({ status: 0, ok: false, error: "Failed to fetch", items: [] });
  });
});

describe("meScript", () => {
  it("names the signed-in account and its karma", async () => {
    page("https://www.reddit.com/");
    answer({ body: { kind: "t2", data: { name: "acme_team", link_karma: 100, comment_karma: 50, total_karma: 150, inbox_count: 2 } } });
    expect(await run<MeSnapshot>(meScript())).toMatchObject({ signed_in: true, name: "acme_team", link_karma: 100, comment_karma: 50, total_karma: 150, inbox_count: 2 });
  });

  it("reads the account without the t2 wrapper too", async () => {
    page("https://www.reddit.com/");
    answer({ body: { name: "acme_team", link_karma: 1, comment_karma: 2 } });
    expect(await run<MeSnapshot>(meScript())).toMatchObject({ signed_in: true, name: "acme_team", total_karma: null });
  });

  it("reports a signed-out session, which reddit.com answers with an empty object", async () => {
    page("https://www.reddit.com/");
    answer({ body: {} });
    expect(await run<MeSnapshot>(meScript())).toMatchObject({ ok: true, signed_in: false, name: "" });
  });
});

describe("aboutScript", () => {
  it("reads a community's subscribers", async () => {
    page("https://www.reddit.com/");
    const asked = answer({ body: { kind: "t5", data: { display_name: "webdev", subscribers: 2410512, active_user_count: 1234, subreddit_type: "public" } } });
    expect(await run<AboutSnapshot>(aboutScript("webdev"))).toMatchObject({ found: true, name: "webdev", subscribers: 2410512, active: 1234, type: "public" });
    expect(asked[0]!.path).toBe("/r/webdev/about.json?raw_json=1");
  });

  it("does not take search results for a community", async () => {
    page("https://www.reddit.com/");
    answer({ body: listing({ kind: "t5", data: { display_name: "webdevelopment" } }) });
    expect(await run<AboutSnapshot>(aboutScript("nosuchcommunity"))).toMatchObject({ ok: true, found: false, subscribers: null });
  });
});

describe("paths", () => {
  it("never marks the inbox read", () => {
    expect(inboxPath(25)).toContain("mark=false");
  });

  it("searches newest first, with the query encoded", () => {
    expect(searchPath('nextbrowser OR "next browser"', 25)).toBe(
      "/search.json?q=nextbrowser%20OR%20%22next%20browser%22&sort=new&t=week&type=link&limit=25&raw_json=1",
    );
  });
});
