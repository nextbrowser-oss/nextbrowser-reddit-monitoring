# CLI reference

`reddit-monitor` runs the engine against one Nextbrowser profile from a terminal. It exists for developing the engine and for running it without the app.

```bash
npm ci && npm run build
node dist/node/bin.js <command> --profile <name> [options]
```

After `npm link`, or when the package is installed with its bin, the same command is available as `reddit-monitor`.

## Commands

| Command | What it does |
| --- | --- |
| `run` | Runs passes until stopped. Waits `--interval` between them, with a random spread. |
| `once` | Runs one pass and exits. |
| `state` | Prints the saved state as JSON. |

## What is watched

| Flag | Default | Meaning |
| --- | --- | --- |
| `--keywords "a,b c"` | none | Words and phrases to find, separated by commas. Phrases keep their spaces. Replaces the saved list. |
| `--exclude "a,b"` | none | Words that drop an item even when a keyword matched. |
| `--communities a,b` | none | Communities read on every pass, with or without `r/`. |
| `--urgent-terms "a,b"` | a built-in list | Terms that make an item urgent. |
| `--no-search` / `--search` | on | Whether to search all of Reddit for the keywords. |
| `--no-comments` / `--comments` | on | Whether to read the watched communities' comments. |
| `--no-inbox` / `--inbox` | on | Whether to read mentions, replies and messages. |
| `--no-karma` / `--karma` | on | Whether to track the account's karma. |
| `--no-subscribers` / `--subscribers` | on | Whether to track the communities' subscribers. |

## How often

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interval 10m` | 10 min | Time between passes. Minimum 1 min, spread ±20%. |
| `--counts-interval 30m` | 30 min | Time between reads of one community's subscribers. Minimum 5 min; `0` reads them on every pass. |
| `--max-age 24h` | 24 h | Older items are not announced. |
| `--limit 25` | 25 | Entries one listing request asks for, 1–100. |

Durations accept `ms`, `s`, `m`, `h`, and `d`, and a plain number means seconds.

## Browser

| Flag | Default | Meaning |
| --- | --- | --- |
| `--nbc PATH` | app's `nextctl`, then `nbc` | The CLI that drives the profile. `NBC_BIN` and `NEXTCTL_BIN` are also honored. |
| `--runtime-root DIR` | the app's | Where the app keeps profiles and sessions. `NEXTBROWSER_RUNTIME_ROOT` also works. |
| `--runtime NAME` | profile's own | Passed to nbc as `--runtime`. |
| `--no-start` | starts | Do not start the profile. Fail if it is not running. |
| `--keep-tab` | parks | Leave the last page open instead of `about:blank`. |

## Output

| Flag | Default | Meaning |
| --- | --- | --- |
| `--state FILE` | `~/.nextbrowser/reddit-monitoring/<profile>.json` | Where the state is kept between runs. |
| `--format text\|json` | text on a terminal, JSON otherwise | The format of stdout. |
| `--verbose` | off | Write the engine's log and every nbc call to stderr as JSON lines. |

Settings given as flags are saved in the state file and apply to later runs too.

In `text` format, a match takes two lines: the time, the urgency, where it was found, who wrote it and what it says; then, indented, the reasons and the link.

```text
09:10  HIGH    r/selfhosted  u/mira_codes: "Acme sync broken after the update?"
        [Says "broken" · Asks a question · "acme" is in the title]  https://www.reddit.com/r/selfhosted/comments/1fx2a9/
```

In `json` format, stdout carries one object per line:

- every [event](events-and-state.md#events);
- `{"type":"pass","at":…,"summary":{…}}` after each pass;
- `{"type":"error","at":…,"error":"…"}` when the profile would not start. `run` then tries again at the next interval.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Finished, or stopped with <kbd>Ctrl</kbd>+<kbd>C</kbd>. |
| `1` | An error, such as a profile that would not start under `once`, or a bad flag. |
| `2` | No command, or an unknown one. Usage is printed. |
| `3` | `once` found the profile signed out while the settings ask for the inbox or the karma. |
| `4` | `once` was refused by reddit.com or stopped by its rate limit. |
| `130` | A second <kbd>Ctrl</kbd>+<kbd>C</kbd> while a pass was still finishing. |
