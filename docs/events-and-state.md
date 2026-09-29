# Events and state

## Events

Every event is a plain JSON object with a `type` field and an `at` field, the pass time in epoch milliseconds. A pass returns its events in `result.events`. With `onEvent`, it also hands over each event as soon as it happens.

### `new_item`

Something new that matched: a mention or reply in the inbox, or a post or comment that names a keyword.

```json
{
  "type": "new_item",
  "at": 1790672400000,
  "account": "acme_team",
  "source": { "kind": "community", "name": "r/selfhosted" },
  "keywords": ["acme"],
  "triage": {
    "urgency": "high",
    "score": 5,
    "reasons": ["Says \"broken\"", "Asks a question", "\"acme\" is in the title"]
  },
  "item": {
    "key": "t3_1fx2a9",
    "id": "1fx2a9",
    "kind": "post",
    "subreddit": "selfhosted",
    "author": "mira_codes",
    "title": "Acme sync broken after the update?",
    "text": "Since 3.2 the sync stops after a few minutes…",
    "url": "https://www.reddit.com/r/selfhosted/comments/1fx2a9/acme_sync_broken_after_the_update/",
    "createdAt": 1790671800000,
    "score": 4,
    "comments": 0,
    "flair": "Help",
    "nsfw": false
  }
}
```

| Field | Meaning |
| --- | --- |
| `account` | The monitored account, when the profile is signed in. |
| `source.kind` | `inbox`, `community`, or `search`. `source.name` is `inbox`, `r/<name>`, or the search query. |
| `keywords` | The keywords the item names. Empty for an inbox item and for a new post in a community watched without keywords. |
| `triage.urgency` | `high`, `medium`, or `low`. `score` is the points behind it; `reasons` say why, strongest first. See [how it works](how-it-works.md#4-urgency-triage). |
| `item.key` | The fullname (`t3_…` post, `t1_…` comment, `t4_…` message): what a reply is posted under. |
| `item.title` | A post's title, the title of the post a comment is on, or a message's subject. |
| `item.text` | A post's text or a comment's or message's body, cut to 2,000 characters. Empty for a link post. |
| `item.url` | Where to open it. For an inbox comment, its context link. |
| `item.linkUrl` | A link post's outbound address. |
| `item.comments` | A post's comment count when it was read. |
| `item.addressed` | For an inbox item: `mention`, `comment_reply`, `post_reply`, or `message`. |

### `karma_changed`

The signed-in account's total karma moved.

```json
{ "type": "karma_changed", "at": 1790674200000, "handle": "acme_team", "previous": 1204, "current": 1240, "delta": 36, "post": 610, "comment": 630 }
```

### `subscribers_changed`

A watched community's subscriber count moved.

```json
{ "type": "subscribers_changed", "at": 1790674200000, "community": "selfhosted", "previous": 612480, "current": 612992, "delta": 512 }
```

### `signed_in`, `signed_out`, `account_changed`

```json
{ "type": "signed_in", "at": 1790672400000, "handle": "acme_team" }
{ "type": "signed_out", "at": 1790676000000, "handle": "acme_team" }
{ "type": "account_changed", "at": 1790679600000, "previous": "acme_team", "current": "other_account" }
```

- **`signed_out`** is emitted once when the session ends. While the profile stays signed out, communities and search are still read; the inbox and karma are not.
- **`signed_in`** is emitted on the first pass, and again after a sign-out.
- **`account_changed`** means the next inbox read starts from scratch, as a new starting line.

## The matches as read

`result.matches` holds every item the pass found that matched, new or not, inside the `maxItemAgeMs` window, most urgent first and newest first within a level. The events say what is new. `matches` says what there is right now, which is what a dashboard displays, including after the first pass, which announces nothing.

## The pass summary

`result.summary` describes one pass, for a status line or a panel:

| Field | Meaning |
| --- | --- |
| `signedIn`, `handle` | Who the pass found signed in. |
| `loginRequired` | The settings ask for the inbox or the karma, and the profile is signed out. Public reads went on. |
| `blocked` | Why the pass stopped reading, e.g. "reddit.com refused the request (HTTP 403: Blocked)." The next pass should back off. |
| `rateLimited` | reddit.com's rate limit for the account ran low and the pass stopped early. |
| `requests` | Requests made to reddit.com. |
| `sourcesRead`, `baselines` | Listings read, and how many of them were read for the first time (announcing nothing). |
| `itemsRead`, `matches` | Entries the listings held, and those that matched inside the age window. |
| `newItems`, `urgent` | New matches, and how many of them are *high*. |
| `countChecks`, `countChanges` | Karma and subscriber counts read, and those that changed. |
| `stopped` | `shouldStop` ended the pass early. |
| `notes` | Up to five sentences a person can read. |

## The state document

```jsonc
{
  "version": 1,
  "settings": { /* see below */ },
  "account": { "handle": "acme_team", "signedIn": true, "checkedAt": 1790672400000 },
  "sources": {
    "inbox":                 { "since": 1790668800000, "filter": "", "lastReadAt": 1790672400000 },
    "r/selfhosted:posts":    { "since": 1790668800000, "filter": "acme", "lastReadAt": 1790672400000, "lastNewAt": 1790672400000 },
    "r/selfhosted:comments": { "since": 1790668800000, "filter": "acme", "lastReadAt": 1790672400000 },
    "search:acme":           { "since": 1790668800000, "filter": "acme", "lastReadAt": 1790672400000 }
  },
  "seen": ["t3_1fx29z", "t1_k7q2m1", "t3_1fx2a9"],   // last 3,000 fullnames, all sources
  "karma": {
    "owner": "acme_team", "total": 1240, "post": 610, "comment": 630,
    "checkedAt": 1790674200000, "changedAt": 1790674200000,
    "history": [{ "at": 1790668800000, "value": 1204 }, { "at": 1790674200000, "value": 1240 }]
  },
  "communities": {
    "selfhosted": {
      "name": "selfhosted", "subscribers": 612992, "active": 1840,
      "checkedAt": 1790674200000, "attemptedAt": 1790674200000, "changedAt": 1790674200000,
      "history": [{ "at": 1790668800000, "value": 612480 }, { "at": 1790674200000, "value": 612992 }]
    }
  },
  "lastPass": { "at": 1790674200000, "finishedAt": 1790674214000, "newItems": 0, "urgent": 0, "countChanges": 2, "notes": [] }
}
```

- `sources[*].since` is the source's starting line: nothing created before it is announced. `filter` is the keyword set it was read with; a different set starts a new line.
- `karma.history` and `communities[*].history` record every change, capped at the latest 200. They are enough to draw a chart without a separate store.

Pass anything read from storage through `normalizeState`. It accepts older versions, hand edits, and missing fields, and fills in defaults.

## Settings

Settings live in `state.settings`. `normalizeState` and `withSettings` clamp them to safe ranges.

| Setting | Default | Range and meaning |
| --- | --- | --- |
| `keywords` | `[]` | Up to 20 words or phrases, 2–60 characters each. |
| `excludeKeywords` | `[]` | Up to 20 words that drop an item even when a keyword matched. |
| `communities` | `[]` | Up to 25 community names, without `r/`. A pasted `r/name` or community URL is accepted. |
| `searchAll` | `true` | Search all of Reddit for the keywords. |
| `watchComments` | `true` | Read the watched communities' newest comments, when keywords are set. |
| `watchInbox` | `true` | Read mentions, replies and messages. Needs a signed-in profile. |
| `urgentTerms` | a built-in list | Up to 50 terms that make an item urgent. `[]` turns the rule off. |
| `itemLimit` | `25` | 1–100 entries per listing request. Comment listings ask for twice as many, up to 100. |
| `maxItemAgeMs` | 24 h | Older items are not announced. `0` turns the limit off. |
| `trackKarma` | `true` | Track the signed-in account's karma. Costs no request. |
| `trackSubscribers` | `true` | Track the watched communities' subscribers. One request each when due. |
| `countsIntervalMs` | 30 min | At least 5 min, or `0` to read the counts on every pass. A read that failed is retried after 10 min. |
| `parkTab` | `true` | Leave the tab on `about:blank` after a pass. |

For the time between passes, `scheduleDelay(intervalMs)` returns the interval with a ±20% random spread. It never returns less than one minute, and with `backOff` (after a refusal or a rate limit) it triples the wait.
