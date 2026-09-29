// A stand-in reddit.com for engine tests. The engine labels every evaluate
// with what it reads ("me", "listing r/webdev:posts", "about r/webdev"), so
// the fake answers by label instead of running the scripts; the scripts
// themselves are tested against stand-in responses in scripts.test.ts.

import type { MonitorBrowser } from "../browser.js";
import type { AboutSnapshot, FetchMeta, ListingSnapshot, MeSnapshot, OriginSnapshot, RawItem } from "../scripts.js";

export interface FakeCommunity {
  posts: RawItem[];
  comments: RawItem[];
  subscribers?: number;
  /** Answer every read of this community with an error: reddit.com's reason
   *  and status, e.g. { status: 403, reason: "private" }. */
  error?: { status: number; reason: string };
}

export class FakeReddit implements MonitorBrowser {
  url = "about:blank";
  signedIn = true;
  handle = "acme_team";
  karma = { link: 100, comment: 50 };
  /** What the landing page shows instead of JSON, when reddit.com refuses the
   *  profile. */
  landingRefused = "";
  inbox: RawItem[] = [];
  communities: Record<string, FakeCommunity> = {};
  /** What any search returns. The fake does not search; the engine matches
   *  every result again, which is what is under test. */
  searchResults: RawItem[] = [];
  /** Answer the listing with this key as a refusal page. */
  refuseListing = "";
  /** reddit.com's x-ratelimit-remaining, counted down per request; null sends
   *  no header. */
  rateLimit: number | null = null;
  /** Answer the listing with this key with a 429. */
  throttleListing = "";
  readonly opened: string[] = [];
  readonly labels: string[] = [];

  async open(url: string): Promise<void> {
    this.url = url;
    this.opened.push(url);
  }

  async waitForLoad(): Promise<void> {}

  async evaluate<T>(_script: string, label = ""): Promise<T> {
    this.labels.push(label);
    return this.answer(label) as T;
  }

  /** The keys of every listing read, in order: "inbox", "r/x:posts", … */
  get listings(): string[] {
    return this.labels.filter((label) => label.startsWith("listing ")).map((label) => label.slice("listing ".length));
  }

  private meta(status = 200): FetchMeta {
    if (this.rateLimit !== null) this.rateLimit -= 1;
    return { path: "", status, ok: status >= 200 && status < 300, refused: "", error: "", reason: "", ratelimit_remaining: this.rateLimit, ratelimit_reset: null };
  }

  private answer(label: string): unknown {
    if (label === "origin") {
      const onReddit = /^https:\/\/(www\.)?reddit\.com\//.test(this.url);
      return { url: this.url, on_reddit: onReddit, refused: onReddit ? this.landingRefused : "" } satisfies OriginSnapshot;
    }
    if (label === "me") {
      const karma = this.signedIn
        ? { link_karma: this.karma.link, comment_karma: this.karma.comment, total_karma: this.karma.link + this.karma.comment }
        : { link_karma: null, comment_karma: null, total_karma: null };
      return { ...this.meta(), signed_in: this.signedIn, name: this.signedIn ? this.handle : "", inbox_count: 0, ...karma } satisfies MeSnapshot;
    }
    if (label.startsWith("listing ")) return this.listing(label.slice("listing ".length));
    if (label.startsWith("about r/")) {
      const community = this.communities[label.slice("about r/".length)];
      if (!community || community.error) {
        const meta = this.meta(community?.error?.status ?? 200);
        return { ...meta, ok: !community, reason: community?.error?.reason ?? "", found: false, name: "", subscribers: null, active: null, type: "" } satisfies AboutSnapshot;
      }
      const name = label.slice("about r/".length);
      return { ...this.meta(), found: true, name, subscribers: community.subscribers ?? null, active: 12, type: "public" } satisfies AboutSnapshot;
    }
    throw new Error(`the fake has no answer for "${label}"`);
  }

  private listing(key: string): ListingSnapshot {
    if (key === this.refuseListing) return { ...this.meta(403), ok: false, refused: "Blocked", items: [] };
    if (key === this.throttleListing) return { ...this.meta(429), ok: false, items: [] };
    if (key === "inbox") return { ...this.meta(), items: this.inbox };
    if (key.startsWith("search:")) return { ...this.meta(), items: this.searchResults };
    const match = /^r\/([^:]+):(posts|comments)$/.exec(key);
    const community = match ? this.communities[match[1]!] : undefined;
    if (!match || !community) return { ...this.meta(404), ok: false, reason: "", items: [] };
    if (community.error) return { ...this.meta(community.error.status), ok: false, reason: community.error.reason, items: [] };
    return { ...this.meta(), items: match[2] === "posts" ? community.posts : community.comments };
  }
}

/** NOON is the time minute 0 of the helpers below stands for. */
export const NOON = Date.UTC(2026, 8, 29, 12, 0, 0);

let serial = 0;

function base(kind: string, id: string, minute: number): RawItem {
  return {
    kind, id, name: `${kind}_${id}`, subreddit: "", author: "someone", title: "", text: "",
    permalink: "", link_url: "", created: (NOON + minute * 60_000) / 1000, score: 1, comments: null,
    flair: "", nsfw: false, stickied: false, removed: false, type: "", subject: "", unread: false,
  };
}

/** post builds a post created `minute` minutes after NOON. */
export function post(subreddit: string, minute: number, title: string, patch: Partial<RawItem> = {}): RawItem {
  const id = `p${serial++}`;
  return { ...base("t3", id, minute), subreddit, title, permalink: `/r/${subreddit}/comments/${id}/slug/`, comments: 3, ...patch };
}

/** comment builds a comment created `minute` minutes after NOON. */
export function comment(subreddit: string, minute: number, text: string, patch: Partial<RawItem> = {}): RawItem {
  const id = `c${serial++}`;
  return { ...base("t1", id, minute), subreddit, text, title: "The post it is on", permalink: `/r/${subreddit}/comments/abc/slug/${id}/`, ...patch };
}

/** mention builds an inbox entry: a username mention by default. */
export function mention(minute: number, text: string, patch: Partial<RawItem> = {}): RawItem {
  const id = `m${serial++}`;
  return {
    ...base("t1", id, minute), subreddit: "webdev", text, title: "Some thread", type: "username_mention",
    subject: "username mention", permalink: `/r/webdev/comments/abc/slug/${id}/?context=3`, unread: true, ...patch,
  };
}
