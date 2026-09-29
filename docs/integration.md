# Integration guide

The package has two entry points:

| Entry | Contents | Runs in |
| --- | --- | --- |
| `@nextbrowser-oss/reddit-monitoring` | `runPass`, `checkAccount`, state and settings, events, keyword matching, `triage`, `scheduleDelay` | Anywhere. It has no Node imports; [`src/core.test.ts`](../src/core.test.ts) enforces this. |
| `@nextbrowser-oss/reddit-monitoring/node` | `nbcBrowser` (a browser over the `nbc`/`nextctl` CLI), `loadState`/`saveState`, the CLI | Node.js 22 or later |

## Installing

The package is consumed from Git. `prepare` builds `dist/` on install:

```bash
npm install github:nextbrowser-oss/nextbrowser-reddit-monitoring#<commit-or-tag>
```

Pin a commit or a tag rather than a branch, so a rebuild of the app never picks up an unreviewed change.

## The contract with Nextbrowser

The app owns everything that has a lifetime:

- the browser, prepared for the selected profile;
- the timer;
- the storage.

The engine owns only the logic of one pass.

```ts
import {
  normalizeState,
  runPass,
  scheduleDelay,
  withSettings,
  type MonitorEvent,
} from "@nextbrowser-oss/reddit-monitoring";
import { cliBrowser } from "./lib/xreply/browser";

async function monitorPass(profileArgs: string[]) {
  const saved = normalizeState(await readAppData("reddit-monitor-state.json"));
  const { state, events, summary, matches } = await runPass({
    browser: cliBrowser(profileArgs),
    state: saved,
    log: (entry) => appendAppData("reddit-monitor-log.jsonl", entry),
    onStep: (step) => setStatus(step),
    onEvent: (event: MonitorEvent) => showNotification(event),
    shouldStop: () => stopRequested,
  });
  await writeAppData("reddit-monitor-state.json", state);
  showMatches(matches);
  return scheduleDelay(10 * 60_000, { backOff: !!summary.blocked || summary.rateLimited });
}

// Settings changed in the UI: patch them, normalized.
const next = withSettings(saved, { keywords: ["nextbrowser", "next browser"], communities: ["webdev"] });
```

### What to show

`result.matches` holds every item the pass found that matched, new or not, inside the `maxItemAgeMs` window, most urgent first. A first pass announces nothing, but it still returns what it found, so a dashboard is never empty after Start. `result.events` holds what is new; a dashboard marks those.

Each match carries its `triage.reasons`. Show them: they are what makes a *high* believable.

### From a match to a reply

The engine never answers. In Nextbrowser, a match is handed to the Reddit skill's reply agent, which drafts a reply to that specific item and shows it to the user; only an approved reply is posted. Pass the match's `item.url`, `item.key` (the fullname the reply is posted under) and `source` to that flow.

### Showing the account before anything runs

`checkAccount` opens reddit.com in the profile, reads who is signed in, and stops there. It reads no listings, and it leaves the page open for a person who is about to sign in. Nextbrowser calls it from its *Open reddit.com* button, so the panel names the account before the first scheduled pass.

```ts
import { checkAccount } from "@nextbrowser-oss/reddit-monitoring";

const { signedIn, handle, karma, blocked } = await checkAccount({ browser: cliBrowser(profileArgs) });
```

### The browser

`MonitorBrowser` is a subset of the app's `XBrowser` (`src/lib/xreply/browser.ts`), so the app can pass its existing `cliBrowser(profileArgs)` as it is:

```ts
interface MonitorBrowser {
  open(url: string): Promise<void>;
  evaluate<T>(script: string, label?: string): Promise<T>;   // the script may return a promise
  waitForLoad(timeoutSeconds?: number): Promise<void>;
}
```

Every read is an `evaluate` of an async script that fetches one JSON listing from the tab's origin. nbc evaluates with `awaitPromise`, so the script's promise is resolved before the value comes back.

### Sharing the profile

The monitor, the Reddit reply agent, and the user's own agent runs may all drive the same profile. They must take turns, because a pass that navigates the tab away from reddit.com leaves the next request with nowhere to fetch from. Run the monitor pass in the queue the app already uses for its other engine passes. Do not run it beside them.

### State

The state is one JSON document. Store it as it is, and pass whatever comes back from storage through `normalizeState`. That function accepts older files, hand edits, and nothing at all. The layout is described in [events and state](events-and-state.md).

### Logging

`log` receives one JSON object per step: every request with its status, timing and rate-limit headroom, every listing with how many items it held and how many were new, and every event. The pass summary keeps at most five notes. When a read fails on a user's machine, the log is the full record, so append it to a rotated file.

## Outside the app: the Node adapter

```ts
import { runPass, withSettings } from "@nextbrowser-oss/reddit-monitoring";
import { loadState, nbcBrowser, saveState } from "@nextbrowser-oss/reddit-monitoring/node";

const browser = nbcBrowser({ profile: "my-reddit-profile" });
await browser.start();
const path = "state.json";
const state = withSettings(await loadState(path), { keywords: ["nextbrowser"] });
const result = await runPass({ browser, state });
await saveState(path, result.state);
```

`nbcBrowser` runs `nbc --profile <name> <command> … --format json` and reads nbc's `{ok, data, error}` envelope. By default it uses the app's own setup:

| Setting | Default |
| --- | --- |
| Runtime root | `~/.nextbrowser/runtime` on macOS, `<userData>/runtime` elsewhere |
| Environment | the same `CLAWBROWSER_*`, `NBC_PROFILE_ROOT` and `NEXTBROWSER_CONFIG_DIR` values the app passes |
| Binary | the app's managed `nextctl`, otherwise `nbc` from `PATH` |

With these defaults it can drive the profiles the app manages. Override the runtime root with `runtimeRoot`, the binary with `binary`, and add browser switches with `browserArgs`. Note that nbc refuses browser switches on proxied profiles.
