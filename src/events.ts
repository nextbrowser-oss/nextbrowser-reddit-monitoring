// What a pass reports. Events are plain JSON, so a caller can store them, send
// them over IPC, or print them one per line.

import type { RedditItem } from "./items.js";
import type { Triage } from "./triage.js";

/** Where an item was found. */
export interface ItemSource {
  kind: "inbox" | "community" | "search";
  /** "inbox", "r/<name>", or the search query. */
  name: string;
}

/** An item that matched, ranked, with where it came from. It is what a
 *  new_item event carries, and what a pass hands back for a dashboard. */
export interface Match {
  item: RedditItem;
  source: ItemSource;
  /** The keywords it names. Empty for an inbox item, which is addressed to the
   *  account, and for a new post in a community watched without keywords. */
  keywords: string[];
  triage: Triage;
}

/** Something new that matched: a mention, a reply, or a post or comment that
 *  names a keyword. */
export interface NewItemEvent extends Match {
  type: "new_item";
  at: number;
  /** The monitored account, when the profile is signed in. */
  account?: string;
}

/** The signed-in account's karma moved. */
export interface KarmaChangedEvent {
  type: "karma_changed";
  at: number;
  handle: string;
  previous: number;
  current: number;
  delta: number;
  post?: number;
  comment?: number;
}

/** A watched community's subscriber count moved. */
export interface SubscribersChangedEvent {
  type: "subscribers_changed";
  at: number;
  community: string;
  previous: number;
  current: number;
  delta: number;
}

/** The profile is signed in to reddit.com, for the first time or again. */
export interface SignedInEvent {
  type: "signed_in";
  at: number;
  handle?: string;
}

/** The profile is signed out of reddit.com. Public reads go on; the inbox and
 *  karma wait until someone signs it in again. */
export interface SignedOutEvent {
  type: "signed_out";
  at: number;
  handle?: string;
}

/** A different account is signed in than before. Its inbox starts over. */
export interface AccountChangedEvent {
  type: "account_changed";
  at: number;
  previous: string;
  current: string;
}

export type MonitorEvent =
  | NewItemEvent
  | KarmaChangedEvent
  | SubscribersChangedEvent
  | SignedInEvent
  | SignedOutEvent
  | AccountChangedEvent;
