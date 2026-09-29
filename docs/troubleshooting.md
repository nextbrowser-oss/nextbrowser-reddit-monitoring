# Troubleshooting

Start with the log. In the app, it is the monitor's log file. In the CLI, run with `--verbose` to get every step and every nbc call on stderr. A `request` entry carries the status, the time it took, what reddit.com's rate-limit headers said, and, when the answer was a page instead of JSON, what that page said (`refused`).

## "reddit.com refused the profile" or "reddit.com refused the request (HTTP 403: …)"

reddit.com answered with a page instead of data, most often "You've been blocked by network security." It judges the connection, not the account. Common causes:

- **The proxy's address has a poor reputation with Reddit.** Datacenter addresses are refused far more often than residential ones. Try the profile with another proxy or country.
- **Too many requests from the same address.** Keep `--interval` at ten minutes or more, and watch fewer communities.
- **Exhausted proxy traffic.** nbc reports `PROXY_TRAFFIC_EXHAUSTED`.

Open reddit.com in the profile by hand: if the site itself shows the block page, no setting of the monitor will get past it. After a refusal the CLI waits three intervals before trying again.

## "reddit.com could not be reached"

The request got no answer within 20 seconds, or the network failed. Check the proxy with Nextbrowser's proxy diagnostics.

## "reddit.com's rate limit for this account ran low"

reddit.com tells each session how many requests it has left, and the monitor stops before that runs out. The rest is read on the next pass. If it happens on every pass, lower `--limit`, drop a few communities, or raise `--interval`. Other tools that use the same account's session count against the same limit.

## "The profile is not signed in to reddit.com"

`/api/me.json` said nobody is signed in. Communities and search are still read; the inbox and the karma wait. Open the profile in Nextbrowser, sign in to reddit.com, and the next pass picks up from there.

## "r/name is private", "is banned", "was not found"

- **Private** communities can only be read by approved members. Sign in with an account that is one, or remove the community.
- **Banned** communities no longer exist on Reddit.
- **Not found**: check the spelling. The name is the part after `r/` in the community's address.
- **Quarantined** communities have to be opened once in the profile, where Reddit asks to confirm the warning. The monitor never confirms it for you.

## A keyword finds nothing that Reddit's search shows

Keywords match whole words only: "next" does not match "nextbrowser", and a search for "browser" that shows "browsing" is Reddit stemming the word. Add the forms you mean as keywords of their own. Reddit's search also covers posts only: a comment that names the keyword is found only in a community you watch.

## Too many matches, or the wrong ones

- Add exclusion words for the noise that keeps coming back ("hiring", "giveaway", a namesake).
- Communities watched without keywords report every new post. Add keywords to report only what names them.
- Lower `--max-age` if old items are still surfacing after a pause.

## An urgent item is marked "low"

The triage rules are listed in [how it works](how-it-works.md#4-urgency-triage). The urgent terms are a setting: add the words your users write when something is wrong ("won't sync", "lost my data") with `--urgent-terms`, or in the app's settings.

## The profile does not start

`reddit-monitor` starts the profile through nbc, and nbc reports why a start failed. Messages seen in practice:

| nbc says | Meaning |
| --- | --- |
| `ClawBrowser does not expose managed-proxy privacy capability 2` | The installed browser runtime is older than nbc requires for proxied profiles. Update the browser runtime from the Nextbrowser app. |
| `browser switch "--…" is not allowed before proxied runtime privacy verification` | A browser switch was passed to a proxied profile. Do not pass `browserArgs` for proxied profiles. |
| `SESSION_NOT_FOUND` | nbc is looking in the wrong runtime root. Point `--runtime-root` at the app's (`~/.nextbrowser/runtime` on macOS). |
| `API_KEY_REQUIRED`, `API_KEY_INVALID` | The Nextbrowser account setup is incomplete. Sign in to the app. |

In `run` mode, a profile that does not start is reported and retried at the next interval. `once` exits with code 1.

## Reporting a problem

Open a [bug report](https://github.com/nextbrowser-oss/nextbrowser-reddit-monitoring/issues/new/choose) and include:

- the version or commit;
- the relevant `--verbose` log lines, with usernames and message text removed if they are private;
- the `status` and `refused` fields of the failing request.
