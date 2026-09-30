// Urgency triage: which of the items a pass found deserve an answer first.
//
// The rules are few, fixed and written out, on purpose. A person deciding what
// to answer first has to be able to see why the monitor put an item on top,
// and so does anyone reading this code before trusting it with their account.
// Every rule adds points and a reason in plain words; the points pick the
// level. No model is involved and nothing leaves the machine.
//
//   addressed to the account (mention, reply, private message)   +4
//   says one of the urgent terms ("refund", "broken", …), when   +3
//   it names a keyword or is addressed to the account
//   asks a question                                              +1
//   a keyword is in the post's title                             +1
//   a post nobody has answered yet                               +1
//   a post picking up comments or votes fast                     +1
//
//   4 or more: high · 2–3: medium · otherwise: low

import { keywordMatcher, type Matcher } from "./keywords.js";
import { matchText, type RedditItem } from "./items.js";

export type Urgency = "high" | "medium" | "low";

export interface Triage {
  urgency: Urgency;
  /** The points behind the level, for sorting within a level. */
  score: number;
  /** Why, in plain words, strongest first. */
  reasons: string[];
}

/** Terms that usually mean someone needs an answer soon. They are the
 *  default for the urgentTerms setting; a team replaces them with its own. */
export const DEFAULT_URGENT_TERMS: readonly string[] = [
  "broken",
  "bug",
  "crash",
  "crashes",
  "crashing",
  "down",
  "outage",
  "not working",
  "doesn't work",
  "does not work",
  "stopped working",
  "can't log in",
  "cannot log in",
  "refund",
  "charged",
  "scam",
  "hacked",
  "leak",
  "vulnerability",
  "lawsuit",
  "cancel",
  "urgent",
  "asap",
];

const ADDRESSED_REASON = {
  mention: "Mentions you",
  comment_reply: "Replies to your comment",
  post_reply: "Replies to your post",
  message: "Private message",
} as const;

/** Question words a title starts with, in the languages Reddit is busiest in.
 *  A question mark anywhere in the title or the opening lines counts too. */
const QUESTION_START = /^(how|what|why|where|which|who|when|is|are|does|do|did|can|could|should|would|will|has|have|anyone|any|help|как|что|почему|где|какой|какая|кто|есть ли|подскажите|wie|was|warum|welche|comment|pourquoi|quel|quelle|cómo|qué|por qué|cual|cuál)(?![\p{L}\p{N}_])/iu;

const HOUR = 60 * 60 * 1000;
const BUSY_WINDOW_MS = 12 * HOUR;
const BUSY_COMMENTS = 10;
const BUSY_SCORE = 50;

export interface TriageContext {
  /** The pass time, which ages are measured against. */
  at: number;
  /** The keywords the item matched. */
  keywords: string[];
  /** Finds the urgent terms in a text. */
  urgent: Matcher;
}

function asksQuestion(item: RedditItem): boolean {
  const title = item.title.trim();
  const opening = item.text.slice(0, 300);
  if (title.includes("?") || opening.includes("?")) return true;
  return QUESTION_START.test(item.kind === "comment" ? item.text.trim() : title);
}

function hours(ms: number): string {
  const value = Math.max(1, Math.round(ms / HOUR));
  return `${value} hour${value === 1 ? "" : "s"}`;
}

/** triage ranks one item. */
export function triage(item: RedditItem, context: TriageContext): Triage {
  const reasons: { points: number; text: string }[] = [];
  if (item.addressed) reasons.push({ points: 4, text: ADDRESSED_REASON[item.addressed] });

  const { title, body } = matchText(item);
  // An urgent term only counts where the item is about you: it names a
  // keyword or it is addressed to the account. In a community watched without
  // keywords, "crash" in a stranger's post is that stranger's crash, and
  // ranking it high buried the posts that did need an answer.
  const aboutYou = context.keywords.length > 0 || !!item.addressed;
  const urgent = aboutYou ? context.urgent([item.title, body].filter(Boolean).join("\n")) : [];
  if (urgent.length) reasons.push({ points: 3, text: `Says ${urgent.slice(0, 2).map((term) => `"${term}"`).join(", ")}` });

  if (asksQuestion(item)) reasons.push({ points: 1, text: "Asks a question" });

  if (item.kind === "post" && title) {
    const inTitle = keywordMatcher(context.keywords)(title)[0];
    if (inTitle) reasons.push({ points: 1, text: `"${inTitle}" is in the title` });
  }

  if (item.kind === "post" && item.comments === 0) reasons.push({ points: 1, text: "No replies yet" });

  const age = item.createdAt !== undefined ? context.at - item.createdAt : undefined;
  if (item.kind === "post" && age !== undefined && age >= 0 && age <= BUSY_WINDOW_MS) {
    if ((item.comments ?? 0) >= BUSY_COMMENTS) reasons.push({ points: 1, text: `${item.comments} comments in ${hours(age)}` });
    else if ((item.score ?? 0) >= BUSY_SCORE) reasons.push({ points: 1, text: `${item.score} points in ${hours(age)}` });
  }

  const score = reasons.reduce((sum, reason) => sum + reason.points, 0);
  const urgency: Urgency = score >= 4 ? "high" : score >= 2 ? "medium" : "low";
  return { urgency, score, reasons: reasons.sort((a, b) => b.points - a.points).map((reason) => reason.text) };
}

const ORDER: Record<Urgency, number> = { high: 0, medium: 1, low: 2 };

/** byUrgency sorts triaged entries most urgent first, then newest first. */
export function byUrgency<T extends { triage: Triage; item: RedditItem }>(left: T, right: T): number {
  return ORDER[left.triage.urgency] - ORDER[right.triage.urgency]
    || right.triage.score - left.triage.score
    || (right.item.createdAt ?? 0) - (left.item.createdAt ?? 0);
}
