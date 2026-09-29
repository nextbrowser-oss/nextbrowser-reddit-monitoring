// @nextbrowser-oss/reddit-monitoring — the browser-agnostic core.
//
// Nothing exported from here touches Node: the Nextbrowser app runs it in the
// renderer with its own nextctl-backed browser. The Node adapter (nbc CLI,
// state file, command line) is "@nextbrowser-oss/reddit-monitoring/node".

export type { MonitorBrowser } from "./browser.js";
export {
  checkAccount,
  runPass,
  type AccountCheck,
  type PassDeps,
  type PassResult,
  type PassSummary,
} from "./engine.js";
export type {
  AccountChangedEvent,
  ItemSource,
  KarmaChangedEvent,
  Match,
  MonitorEvent,
  NewItemEvent,
  SignedInEvent,
  SignedOutEvent,
  SubscribersChangedEvent,
} from "./events.js";
export {
  countsDue,
  defaultSettings,
  emptyState,
  normalizeCommunity,
  normalizeSettings,
  normalizeState,
  normalizeUsername,
  withSettings,
  MAX_COMMUNITIES,
  type AccountState,
  type CommunityStats,
  type CountSample,
  type KarmaStats,
  type MonitorSettings,
  type MonitorState,
  type PassRecord,
  type SourceState,
} from "./state.js";
export { normalizeItems, type Addressed, type ItemKind, type RedditItem } from "./items.js";
export {
  keywordMatcher,
  normalizeKeyword,
  normalizeKeywords,
  searchQueries,
  splitKeywords,
  MAX_KEYWORDS,
} from "./keywords.js";
export { byUrgency, triage, DEFAULT_URGENT_TERMS, type Triage, type Urgency } from "./triage.js";
export { LANDING_URL, SIGN_IN_URL } from "./scripts.js";
export type { LogEntry, LogSink } from "./log.js";
export { scheduleDelay, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS } from "./schedule.js";
