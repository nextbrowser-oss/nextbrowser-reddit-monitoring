// reddit-monitor: run the monitor against one Nextbrowser profile from a
// terminal.
//
// Events go to stdout, one JSON object per line (or one readable line each
// with --format text), so another process can follow them; the log goes to
// stderr with --verbose. The state lives in a file between runs.

import { parseArgs } from "node:util";
import { runPass, type PassSummary } from "../engine.js";
import type { MonitorEvent } from "../events.js";
import { splitKeywords } from "../keywords.js";
import type { LogEntry } from "../log.js";
import { DEFAULT_INTERVAL_MS, scheduleDelay } from "../schedule.js";
import { normalizeCommunity, withSettings, type MonitorSettings, type MonitorState } from "../state.js";
import { nbcBrowser } from "./nbc.js";
import { defaultStatePath, loadState, saveState } from "./store.js";

const USAGE = `reddit-monitor — watch Reddit for mentions and keywords through a Nextbrowser profile

Usage:
  reddit-monitor run   --profile NAME [options]   pass after pass until stopped
  reddit-monitor once  --profile NAME [options]   one pass
  reddit-monitor state --profile NAME [--state FILE]   print the saved state

What is watched:
  --keywords "a,b c"       words and phrases to find, comma-separated
  --exclude "a,b"          words that drop an item even when a keyword matched
  --communities a,b        communities read on every pass, without r/
  --urgent-terms "a,b"     terms that make an item urgent (default: a built-in list)
  --no-search / --search   search all of Reddit for the keywords (default: yes)
  --no-comments / --comments   read watched communities' comments (default: yes)
  --no-inbox / --inbox     read mentions, replies and messages (default: yes)
  --no-karma / --karma     track the account's karma (default: yes)
  --no-subscribers / --subscribers   track communities' subscribers (default: yes)

How often:
  --interval 10m           between passes (min 1m, spread ±20%)
  --counts-interval 30m    between reads of one community's subscribers (min 5m)
  --max-age 24h            older items are not announced
  --limit 25               entries one listing request asks for (1-100)

Browser:
  --nbc PATH               nbc or nextctl binary (default: the app's, then PATH)
  --runtime-root DIR       the app's runtime root (default: the app's)
  --runtime NAME           nbc --runtime for the profile
  --no-start               do not start the profile; fail if it is not running
  --keep-tab               leave the last page open instead of about:blank

Output:
  --state FILE             state file (default ~/.nextbrowser/reddit-monitoring/<profile>.json)
  --format json|text       stdout format (default: text on a terminal, json otherwise)
  --verbose                write the monitor's log to stderr as JSON lines

Settings given as flags are saved in the state file and kept for later runs.
`;

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(value: string, flag: string): number {
  const match = DURATION.exec(value.trim());
  if (!match) throw new Error(`${flag}: "${value}" is not a duration like 90s, 5m or 2h`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2] ?? "s"]!);
}

function positiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${flag}: "${value}" is not a whole number`);
  return number;
}

const OPTIONS = {
  profile: { type: "string" },
  state: { type: "string" },
  interval: { type: "string" },
  keywords: { type: "string" },
  exclude: { type: "string" },
  communities: { type: "string" },
  "urgent-terms": { type: "string" },
  "counts-interval": { type: "string" },
  "max-age": { type: "string" },
  limit: { type: "string" },
  search: { type: "boolean" },
  "no-search": { type: "boolean" },
  comments: { type: "boolean" },
  "no-comments": { type: "boolean" },
  inbox: { type: "boolean" },
  "no-inbox": { type: "boolean" },
  karma: { type: "boolean" },
  "no-karma": { type: "boolean" },
  subscribers: { type: "boolean" },
  "no-subscribers": { type: "boolean" },
  nbc: { type: "string" },
  "runtime-root": { type: "string" },
  runtime: { type: "string" },
  "no-start": { type: "boolean" },
  "keep-tab": { type: "boolean" },
  format: { type: "string" },
  verbose: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

/** toggle reads a --x / --no-x pair; the negative wins when both are given. */
function toggle(values: Values, name: string): boolean | undefined {
  const record = values as Record<string, unknown>;
  if (record[`no-${name}`]) return false;
  if (record[name]) return true;
  return undefined;
}

/** settingsFromFlags is the settings patch the flags ask for. */
export function settingsFromFlags(values: Values): Partial<MonitorSettings> {
  const patch: Partial<MonitorSettings> = {};
  const toggles: [string, keyof MonitorSettings][] = [
    ["search", "searchAll"],
    ["comments", "watchComments"],
    ["inbox", "watchInbox"],
    ["karma", "trackKarma"],
    ["subscribers", "trackSubscribers"],
  ];
  for (const [flag, setting] of toggles) {
    const value = toggle(values, flag);
    if (value !== undefined) (patch as Record<string, unknown>)[setting] = value;
  }
  if (values.keywords !== undefined) patch.keywords = splitKeywords(values.keywords);
  if (values.exclude !== undefined) patch.excludeKeywords = splitKeywords(values.exclude);
  if (values["urgent-terms"] !== undefined) patch.urgentTerms = splitKeywords(values["urgent-terms"]);
  if (values.communities !== undefined) {
    const names = values.communities.split(/[\s,]+/).filter(Boolean);
    const invalid = names.filter((name) => !normalizeCommunity(name));
    if (invalid.length) throw new Error(`--communities: not a community name: ${invalid.join(", ")}`);
    patch.communities = names.map(normalizeCommunity);
  }
  if (values["counts-interval"] !== undefined) patch.countsIntervalMs = parseDuration(values["counts-interval"], "--counts-interval");
  if (values["max-age"] !== undefined) patch.maxItemAgeMs = parseDuration(values["max-age"], "--max-age");
  if (values.limit !== undefined) patch.itemLimit = positiveInteger(values.limit, "--limit");
  if (values["keep-tab"]) patch.parkTab = false;
  return patch;
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : /(s|sh|ch|x)$/.test(noun) ? `${noun}es` : `${noun}s`}`;
}

function oneLine(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function signed(delta: number): string {
  return `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`;
}

const LEVEL = { high: "HIGH", medium: "MEDIUM", low: "low" } as const;

/** describeEvent is the readable line for an event. */
export function describeEvent(event: MonitorEvent): string {
  switch (event.type) {
    case "new_item": {
      const { item, source, triage } = event;
      const where = source.kind === "inbox" ? "inbox" : item.subreddit ? `r/${item.subreddit}` : source.name;
      const who = item.addressed === "mention"
        ? `u/${item.author} mentioned you`
        : item.addressed === "comment_reply" || item.addressed === "post_reply"
          ? `u/${item.author} replied`
          : item.addressed === "message"
            ? `u/${item.author} messaged you`
            : item.kind === "comment"
              ? `u/${item.author} commented`
              : `u/${item.author}`;
      const body = item.kind === "post" ? `"${oneLine(item.title, 90)}"` : oneLine(item.text || item.title, 90) || "[no text]";
      // Why and where go on a line of their own, so the first stays short
      // enough to read at a glance in a terminal.
      const why = triage.reasons.length ? `[${triage.reasons.join(" · ")}]  ` : "";
      return `${time(event.at)}  ${LEVEL[triage.urgency].padEnd(6)}  ${where}  ${who}: ${body}\n        ${why}${item.url}`;
    }
    case "karma_changed":
      return `${time(event.at)}  karma u/${event.handle}: ${event.previous.toLocaleString()} → ${event.current.toLocaleString()} (${signed(event.delta)})`;
    case "subscribers_changed":
      return `${time(event.at)}  subscribers r/${event.community}: ${event.previous.toLocaleString()} → ${event.current.toLocaleString()} (${signed(event.delta)})`;
    case "signed_in":
      return `${time(event.at)}  signed in${event.handle ? ` as u/${event.handle}` : ""}`;
    case "signed_out":
      return `${time(event.at)}  signed out${event.handle ? ` (was u/${event.handle})` : ""}: sign the profile in to reddit.com for the inbox and karma`;
    case "account_changed":
      return `${time(event.at)}  account changed: u/${event.previous} → u/${event.current}; the inbox starts over`;
  }
}

/** describePass is the readable line for a finished pass. */
export function describePass(summary: PassSummary, at: number): string {
  const parts: string[] = [];
  if (summary.sourcesRead) {
    const baseline = summary.baselines === summary.sourcesRead;
    parts.push(baseline
      ? `starting line: ${plural(summary.sourcesRead, "source")}, ${plural(summary.matches, "match")}`
      : `${plural(summary.sourcesRead, "source")}: ${summary.newItems} new${summary.urgent ? ` (${summary.urgent} urgent)` : ""} of ${plural(summary.matches, "match")}`);
  }
  if (summary.countChecks) parts.push(`counts: ${summary.countChecks} read, ${summary.countChanges} changed`);
  if (summary.blocked) parts.push("refused");
  if (summary.rateLimited) parts.push("rate-limited");
  if (summary.stopped) parts.push("stopped");
  const who = summary.handle ? ` u/${summary.handle}` : summary.signedIn ? "" : " (signed out)";
  const notes = summary.notes;
  return `${time(at)}  pass${who}: ${parts.join("; ") || "nothing read"}${notes.length ? `\n        ${notes.join("\n        ")}` : ""}`;
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  const command = positionals[0] ?? "";
  if (values.help || !["run", "once", "state"].includes(command)) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }
  const profile = values.profile?.trim();
  if (!profile && !(command === "state" && values.state)) throw new Error("--profile is required");
  const statePath = values.state ?? defaultStatePath(profile ?? "");
  let state: MonitorState = withSettings(await loadState(statePath), settingsFromFlags(values));
  if (command === "state") {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
    return 0;
  }

  const format = values.format ?? (process.stdout.isTTY ? "text" : "json");
  if (format !== "json" && format !== "text") throw new Error(`--format: "${format}" is neither json nor text`);
  const intervalMs = values.interval !== undefined ? parseDuration(values.interval, "--interval") : DEFAULT_INTERVAL_MS;
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const log = values.verbose ? (entry: LogEntry) => process.stderr.write(`${JSON.stringify(entry)}\n`) : undefined;
  const browser = nbcBrowser({
    profile: profile!,
    ...(values.nbc ? { binary: values.nbc } : {}),
    ...(values["runtime-root"] ? { runtimeRoot: values["runtime-root"] } : {}),
    ...(values.runtime ? { runtime: values.runtime } : {}),
    ...(values.verbose ? { trace: (entry) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), ev: "nbc", ...entry })}\n`) } : {}),
  });

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    if (stopping) process.exit(130);
    stopping = true;
    wake?.();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await saveState(statePath, state);
  const wait = (delay: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wake = undefined;
    });

  for (;;) {
    if (!values["no-start"]) {
      try {
        await browser.start();
      } catch (error) {
        // One pass is worth failing over a browser that will not start; a
        // monitor that runs for days is not: the next interval tries again.
        if (command === "once") throw error;
        const message = error instanceof Error ? error.message : String(error);
        const at = Date.now();
        print(format === "json" ? JSON.stringify({ type: "error", at, error: message }) : `${time(at)}  the profile did not start: ${message}`);
        await wait(scheduleDelay(intervalMs));
        if (stopping) return 0;
        continue;
      }
    }
    const result = await runPass({
      browser,
      state,
      ...(log ? { log } : {}),
      shouldStop: () => stopping,
      onEvent: (event) => print(format === "json" ? JSON.stringify(event) : describeEvent(event)),
    });
    state = result.state;
    await saveState(statePath, state);
    const at = state.lastPass?.at ?? Date.now();
    print(format === "json" ? JSON.stringify({ type: "pass", at, summary: result.summary }) : describePass(result.summary, at));
    const backOff = !!result.summary.blocked || result.summary.rateLimited;
    if (command === "once" || stopping) return backOff ? 4 : result.summary.loginRequired ? 3 : 0;
    await wait(scheduleDelay(intervalMs, { backOff }));
    if (stopping) return 0;
  }
}
