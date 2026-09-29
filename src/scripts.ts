// Page scripts: every read the monitor makes on reddit.com.
//
// Reddit serves every listing a person scrolls through as JSON too: add .json
// to the path. The monitor asks for those from a reddit.com tab, with fetch and
// the profile's own cookies, as a same-origin request from the site's own page.
// That is one small request per listing instead of a
// page of markup, pictures and scripts over the proxy, and it reads the same
// data on every front end reddit.com has ever drawn.
//
// Each script is one expression returning a JSON-serializable value, because
// it runs through CDP Runtime.evaluate with returnByValue and awaitPromise.
// Values that come from outside the page — paths, names — are inserted as JSON
// literals, so nothing can break out of the expression. Listings are cut down
// to the fields the monitor uses inside the page, so a search result's
// 40 KB of preview metadata never crosses CDP.

/** jsLiteral renders a value as a JavaScript literal safe to inline. */
export function jsLiteral(value: unknown): string {
  return JSON.stringify(value ?? "");
}

/** Where the monitor's tab lands before it reads anything. /api/me.json is the
 *  lightest page reddit.com serves that is on the same origin as every
 *  listing: a few hundred bytes, no scripts, no pictures. */
export const LANDING_URL = "https://www.reddit.com/api/me.json?raw_json=1";
/** Where a person signs in. It is a real page, because that is what someone
 *  about to sign in wants in front of them. */
export const SIGN_IN_URL = "https://www.reddit.com/";

/** How long one request may take before it is given up. */
const FETCH_TIMEOUT_MS = 20_000;
/** How much of a post's or comment's text is kept. Enough to match keywords
 *  and to show a preview; a 40,000-character essay is not a preview. */
export const TEXT_MAX = 2_000;

/** What one request came back with, whatever it was. */
export interface FetchMeta {
  path: string;
  /** The HTTP status; 0 when the request never got an answer. */
  status: number;
  /** A JSON answer with a 2xx status. */
  ok: boolean;
  /** Set when reddit.com answered with something other than JSON — its
   *  "blocked by network security" page, a CDN error, a sign-in redirect: the
   *  page's title or the start of its text. */
  refused: string;
  /** The request failed before an answer: a network error or the timeout. */
  error: string;
  /** reddit.com's own reason on a JSON error: private, banned, quarantined. */
  reason: string;
  /** What reddit.com's rate-limit headers said, when it sent them. */
  ratelimit_remaining: number | null;
  ratelimit_reset: number | null;
}

/** One listing child, cut down in the page. */
export interface RawItem {
  /** t3 post, t1 comment, t4 private message. */
  kind: string;
  id: string;
  /** The fullname, e.g. "t3_1abcde". */
  name: string;
  subreddit: string;
  author: string;
  /** A post's title, the title of the post a comment is on, or a message's
   *  subject. */
  title: string;
  /** A post's self text, a comment's or message's body. */
  text: string;
  /** The item's permalink, or for an inbox comment its context link. */
  permalink: string;
  /** A link post's outbound URL. */
  link_url: string;
  /** Seconds since the epoch, as reddit.com gives it. */
  created: number | null;
  score: number | null;
  comments: number | null;
  flair: string;
  nsfw: boolean;
  stickied: boolean;
  removed: boolean;
  /** For inbox items: username_mention, comment_reply, post_reply. */
  type: string;
  subject: string;
  /** For inbox items: whether reddit.com still counts it as unread. */
  unread: boolean;
}

export interface ListingSnapshot extends FetchMeta {
  items: RawItem[];
}

export interface MeSnapshot extends FetchMeta {
  signed_in: boolean;
  name: string;
  link_karma: number | null;
  comment_karma: number | null;
  total_karma: number | null;
  inbox_count: number | null;
}

export interface AboutSnapshot extends FetchMeta {
  /** Whether the answer described a community at all. A community that does
   *  not exist answers with search results instead. */
  found: boolean;
  name: string;
  subscribers: number | null;
  /** People reading the community right now, as reddit.com rounds it. */
  active: number | null;
  /** public, restricted, private, archived… */
  type: string;
}

/** Where the tab is, and whether it is on reddit.com's refusal page. */
export interface OriginSnapshot {
  url: string;
  on_reddit: boolean;
  refused: string;
}

/** request() fetches one path from the current origin and never throws: every
 *  outcome is a value the engine can reason about. */
const REQUEST_HELPER = String.raw`
  const request = async (path) => {
    const meta = { path: path, status: 0, ok: false, refused: "", error: "", reason: "", ratelimit_remaining: null, ratelimit_reset: null };
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ${FETCH_TIMEOUT_MS}) : null;
    let response;
    try {
      response = await fetch(path, { credentials: "include", headers: { accept: "application/json" }, signal: controller ? controller.signal : undefined });
    } catch (error) {
      meta.error = String((error && (error.name === "AbortError" ? "timed out" : error.message)) || error).slice(0, 200);
      return { meta: meta, body: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
    meta.status = Number(response.status) || 0;
    const header = (name) => { const value = Number(response.headers.get(name)); return response.headers.get(name) === null || !isFinite(value) ? null : value; };
    meta.ratelimit_remaining = header("x-ratelimit-remaining");
    meta.ratelimit_reset = header("x-ratelimit-reset");
    const type = String(response.headers.get("content-type") || "");
    let text = "";
    try { text = await response.text(); } catch (error) { meta.error = "the answer could not be read"; return { meta: meta, body: null }; }
    let body = null;
    if (/json/i.test(type) || /^\s*[\[{]/.test(text)) {
      try { body = JSON.parse(text); } catch (error) { body = null; }
    }
    if (body === null) {
      const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(text) || [])[1] || "";
      const plain = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      meta.refused = (title.trim() || plain || ("HTTP " + meta.status)).slice(0, 160);
      return { meta: meta, body: null };
    }
    meta.ok = response.ok;
    if (!response.ok && body && typeof body === "object") meta.reason = String(body.reason || body.message || "").slice(0, 80);
    return { meta: meta, body: body };
  };`;

/** compact() keeps what the monitor uses of one listing child. */
const COMPACT_HELPER = String.raw`
  const compact = (child) => {
    if (!child || typeof child !== "object") return null;
    const kind = String(child.kind || "");
    if (kind !== "t1" && kind !== "t3" && kind !== "t4") return null;
    const d = child.data && typeof child.data === "object" ? child.data : {};
    const str = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
    const num = (value) => (typeof value === "number" && isFinite(value) ? value : null);
    const text = kind === "t3" ? d.selftext : d.body;
    return {
      kind: kind,
      id: str(d.id, 24),
      name: str(d.name, 32),
      subreddit: str(d.subreddit, 32),
      author: str(d.author, 32),
      title: str(kind === "t3" ? d.title : kind === "t1" ? d.link_title : d.subject, 400),
      text: str(text, ${TEXT_MAX}),
      permalink: str(kind === "t1" && d.context ? d.context : d.permalink, 500),
      link_url: kind === "t3" && d.is_self === false ? str(d.url, 500) : "",
      created: num(d.created_utc),
      score: num(d.score),
      comments: num(d.num_comments),
      flair: str(d.link_flair_text, 80),
      nsfw: d.over_18 === true,
      stickied: d.stickied === true,
      removed: !!d.removed_by_category || text === "[removed]" || text === "[deleted]",
      type: str(d.type, 40),
      subject: str(d.subject, 160),
      unread: d.new === true
    };
  };`;

/** originScript says whether the tab is on reddit.com, and whether what it
 *  shows there is reddit.com's refusal instead of a page. */
export function originScript(): string {
  return String.raw`(() => {
  const host = String(location.hostname || "").toLowerCase();
  const onReddit = host === "reddit.com" || host.endsWith(".reddit.com");
  const text = String((document.body && document.body.innerText) || "").replace(/\s+/g, " ").trim();
  const refused = /blocked by network security|whoa there, pardner|too many requests/i.test(text) ? text.slice(0, 160) : "";
  return { url: location.href, on_reddit: onReddit, refused: refused };
})()`;
}

/** meScript reads who is signed in, and their karma, from /api/me.json. A
 *  signed-out session gets an empty object there, not an error. */
export function meScript(): string {
  return String.raw`(async () => {${REQUEST_HELPER}
  const got = await request("/api/me.json?raw_json=1");
  const out = Object.assign({ signed_in: false, name: "", link_karma: null, comment_karma: null, total_karma: null, inbox_count: null }, got.meta);
  if (!got.body || typeof got.body !== "object") return out;
  const data = got.body.data && typeof got.body.data === "object" ? got.body.data : got.body;
  const num = (value) => (typeof value === "number" && isFinite(value) ? value : null);
  if (typeof data.name === "string" && data.name) {
    out.signed_in = true;
    out.name = data.name.slice(0, 32);
    out.link_karma = num(data.link_karma);
    out.comment_karma = num(data.comment_karma);
    out.total_karma = num(data.total_karma);
    out.inbox_count = num(data.inbox_count);
  }
  return out;
})()`;
}

/** listingScript reads one listing — a community's new posts or comments, a
 *  search, the inbox — and returns its children cut down in the page. */
export function listingScript(path: string): string {
  return String.raw`(async () => {${REQUEST_HELPER}${COMPACT_HELPER}
  const got = await request(${jsLiteral(path)});
  const out = Object.assign({ items: [] }, got.meta);
  const data = got.body && typeof got.body === "object" && got.body.data && typeof got.body.data === "object" ? got.body.data : null;
  if (got.meta.ok && data && Array.isArray(data.children)) out.items = data.children.map(compact).filter(Boolean);
  return out;
})()`;
}

/** aboutScript reads a community's subscriber count. A community that does
 *  not exist answers with a listing of search results, not an error, so the
 *  answer's kind is what says whether it was found. */
export function aboutScript(community: string): string {
  return String.raw`(async () => {${REQUEST_HELPER}
  const got = await request(${jsLiteral(aboutPath(community))});
  const out = Object.assign({ found: false, name: "", subscribers: null, active: null, type: "" }, got.meta);
  const body = got.body && typeof got.body === "object" ? got.body : null;
  if (!body || body.kind !== "t5" || !body.data || typeof body.data !== "object") return out;
  const d = body.data;
  const num = (value) => (typeof value === "number" && isFinite(value) ? value : null);
  out.found = true;
  out.name = typeof d.display_name === "string" ? d.display_name.slice(0, 32) : "";
  out.subscribers = num(d.subscribers);
  out.active = num(d.active_user_count) !== null ? num(d.active_user_count) : num(d.accounts_active);
  out.type = typeof d.subreddit_type === "string" ? d.subreddit_type.slice(0, 24) : "";
  return out;
})()`;
}

// --- paths ------------------------------------------------------------------

/** raw_json=1 asks for text as it was written: without it reddit.com escapes
 *  every &, < and > as an HTML entity. */
const RAW = "raw_json=1";

export function inboxPath(limit: number): string {
  // mark=false: reading the inbox must never mark anything read. The unread
  // dot is the account owner's, and a monitor that clears it hides replies
  // from the person it is monitoring for.
  return `/message/inbox.json?limit=${limit}&mark=false&${RAW}`;
}

export function communityPostsPath(community: string, limit: number): string {
  return `/r/${encodeURIComponent(community)}/new.json?limit=${limit}&${RAW}`;
}

export function communityCommentsPath(community: string, limit: number): string {
  return `/r/${encodeURIComponent(community)}/comments.json?limit=${limit}&${RAW}`;
}

export function searchPath(query: string, limit: number): string {
  // Newest first, over the last week: the monitor only announces what is
  // newer than its own start line, and a week covers any absence it would
  // still announce anything from.
  return `/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&type=link&limit=${limit}&${RAW}`;
}

export function aboutPath(community: string): string {
  return `/r/${encodeURIComponent(community)}/about.json?${RAW}`;
}

/** Every script with a label, for the tests that make sure each one is at
 *  least a valid expression. */
export function allScripts(): Record<string, string> {
  return {
    origin: originScript(),
    me: meScript(),
    listing: listingScript(inboxPath(25)),
    about: aboutScript("webdev"),
  };
}
