// What the monitor reports about one post, comment or message, and how a raw
// listing child becomes one.

import type { RawItem } from "./scripts.js";

export type ItemKind = "post" | "comment" | "message";

/** How an inbox item reached the account. */
export type Addressed = "mention" | "comment_reply" | "post_reply" | "message";

export interface RedditItem {
  /** The fullname, e.g. "t3_1abcde": unique across posts, comments and
   *  messages, and the same whichever listing the item was found in. */
  key: string;
  id: string;
  kind: ItemKind;
  /** Without the r/. Absent for a private message. */
  subreddit?: string;
  author: string;
  /** A post's title, the title of the post a comment is on, or a message's
   *  subject. */
  title: string;
  /** A post's self text or a comment's or message's body, cut to 2,000
   *  characters. Empty for a link post. */
  text: string;
  /** Where to open it on reddit.com. For an inbox comment, its context. */
  url: string;
  /** A link post's outbound URL. */
  linkUrl?: string;
  /** Milliseconds since the epoch. */
  createdAt?: number;
  score?: number;
  /** A post's comment count when it was read. */
  comments?: number;
  flair?: string;
  nsfw: boolean;
  /** For an inbox item: why it is in the account's inbox. */
  addressed?: Addressed;
}

const ORIGIN = "https://www.reddit.com";

const KINDS: Record<string, ItemKind> = { t3: "post", t1: "comment", t4: "message" };

/** absoluteUrl turns a permalink into a link a person can open. */
function absoluteUrl(permalink: string, kind: ItemKind, id: string): string {
  if (/^https?:\/\//i.test(permalink)) return permalink;
  if (permalink.startsWith("/")) return `${ORIGIN}${permalink}`;
  return kind === "message" ? `${ORIGIN}/message/messages/${id}` : ORIGIN;
}

function addressedAs(raw: RawItem, kind: ItemKind): Addressed | undefined {
  if (kind === "message") return "message";
  switch (raw.type) {
    case "username_mention":
      return "mention";
    case "comment_reply":
      return "comment_reply";
    case "post_reply":
      return "post_reply";
    default:
      return undefined;
  }
}

/** normalizeItems turns listing children into items, in listing order. It
 *  drops what cannot be reported: an entry without an id, and one a moderator
 *  or its author removed, whose text is now "[removed]". */
export function normalizeItems(raw: RawItem[], options: { inbox?: boolean } = {}): RedditItem[] {
  const items: RedditItem[] = [];
  const keys = new Set<string>();
  for (const entry of raw) {
    const kind = KINDS[entry?.kind ?? ""];
    if (!kind || !entry.id) continue;
    if (entry.removed) continue;
    const key = entry.name || `${entry.kind}_${entry.id}`;
    if (keys.has(key)) continue;
    keys.add(key);
    const addressed = options.inbox ? addressedAs(entry, kind) : undefined;
    items.push({
      key,
      id: entry.id,
      kind,
      ...(entry.subreddit ? { subreddit: entry.subreddit } : {}),
      author: entry.author || "[deleted]",
      title: (entry.title || (kind === "message" ? entry.subject : "") || "").trim(),
      text: (entry.text || "").trim(),
      url: absoluteUrl(entry.permalink, kind, entry.id),
      ...(entry.link_url ? { linkUrl: entry.link_url } : {}),
      ...(entry.created !== null && Number.isFinite(entry.created) ? { createdAt: Math.round(entry.created * 1000) } : {}),
      ...(entry.score !== null && Number.isFinite(entry.score) ? { score: entry.score } : {}),
      ...(kind === "post" && entry.comments !== null && Number.isFinite(entry.comments) ? { comments: entry.comments } : {}),
      ...(entry.flair ? { flair: entry.flair } : {}),
      nsfw: entry.nsfw === true,
      ...(addressed ? { addressed } : {}),
    });
  }
  return items;
}

/** matchText is everything of an item a keyword may be found in: the title a
 *  person reads first, the body, and a link post's address, since a brand is
 *  often only named in the link. */
export function matchText(item: RedditItem): { title: string; body: string } {
  const title = item.kind === "post" || item.kind === "message" ? item.title : "";
  const body = [item.text, item.linkUrl ?? ""].filter(Boolean).join("\n");
  return { title, body };
}

/** isOwn says whether the monitored account wrote the item. What the account
 *  itself posted is never news to it. */
export function isOwn(item: RedditItem, handle: string | undefined): boolean {
  return !!handle && item.author.toLowerCase() === handle.toLowerCase();
}
