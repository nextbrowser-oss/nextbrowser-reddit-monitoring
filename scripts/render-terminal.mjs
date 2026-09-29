// Renders assets/reddit-monitor-terminal.svg, the terminal shown at the top of
// the README. Every line comes from the CLI's own formatters
// (dist/node/cli.js), so the picture shows exactly what `reddit-monitor run`
// prints; the accounts, posts and numbers are sample data.
//
//   npm run build && npm run render:terminal

import { writeFile } from "node:fs/promises";
import { describeEvent, describePass } from "../dist/node/cli.js";

const at = (hour, minute) => new Date(2026, 8, 29, hour, minute).getTime();
const item = (kind, subreddit, id, author, title, text, extra = {}) => ({
  key: `${kind === "post" ? "t3" : "t1"}_${id}`, id, kind, subreddit, author, title, text,
  url: `https://www.reddit.com/r/${subreddit}/comments/${id}/`, nsfw: false, ...extra,
});
const found = (time, source, value, urgency, reasons, keywords = ["acme"]) => ({
  type: "new_item", at: time, account: "acme_team", source, item: value, keywords, triage: { urgency, score: 0, reasons },
});
const community = (name) => ({ kind: "community", name: `r/${name}` });
const pass = (patch) => ({
  signedIn: true, handle: "acme_team", loginRequired: false, rateLimited: false, requests: 0, sourcesRead: 5, baselines: 0,
  itemsRead: 0, matches: 0, newItems: 0, urgent: 0, countChecks: 1, countChanges: 0, stopped: false, notes: [], ...patch,
});

const lines = [
  describeEvent({ type: "signed_in", at: at(9, 0), handle: "acme_team" }),
  describePass(pass({ baselines: 5, matches: 11, countChecks: 3 }), at(9, 0)),
  describeEvent(found(at(9, 10), { kind: "inbox", name: "inbox" },
    item("comment", "selfhosted", "k7q2m1", "devon_k", "Backup tools", "u/acme_team is the export fixed yet?", { addressed: "mention" }),
    "high", ["Mentions you", "Asks a question"], [])),
  describeEvent(found(at(9, 10), community("selfhosted"),
    item("post", "selfhosted", "1fx2a9", "mira_codes", "Acme sync broken after the update?", ""),
    "high", ['Says "broken"', "Asks a question", '"acme" is in the title'])),
  describeEvent(found(at(9, 10), community("webdev"),
    item("post", "webdev", "1fx3c4", "tomasz_w", "Acme vs rclone for team backups", ""),
    "medium", ['"acme" is in the title', "No replies yet"])),
  describeEvent(found(at(9, 10), community("sysadmin"),
    item("comment", "sysadmin", "k7q9z0", "quietops", "Backup stack 2026", "Moved the team to Acme last month, no complaints."),
    "low", [])),
  describePass(pass({ matches: 14, newItems: 4, urgent: 2 }), at(9, 10)),
  describeEvent({ type: "karma_changed", at: at(9, 40), handle: "acme_team", previous: 1204, current: 1240, delta: 36 }),
  describeEvent({ type: "subscribers_changed", at: at(9, 40), community: "selfhosted", previous: 612480, current: 612992, delta: 512 }),
  describePass(pass({ matches: 14, countChecks: 3, countChanges: 2 }), at(9, 40)),
];

const COLORS = {
  background: "#0b1120",
  bar: "#111827",
  border: "#1f2937",
  text: "#e5e7eb",
  dim: "#6b7280",
  prompt: "#2dd4bf",
  high: "#f87171",
  medium: "#fbbf24",
  low: "#94a3b8",
  counts: "#60a5fa",
  pass: "#94a3b8",
  user: "#c4b5fd",
  community: "#fb923c",
  reasons: "#a7f3d0",
  up: "#34d399",
  down: "#f87171",
  link: "#64748b",
};

const TOKEN = /(\bHIGH\b|\bMEDIUM\b|(?<=^\s{2})low\b|\bkarma(?= u\/)|\bsubscribers(?= r\/)|\bsigned in\b|\bpass(?= u\/)|\binbox\b|u\/[A-Za-z0-9_-]+|r\/[A-Za-z0-9_]+|https:\/\/\S+|\[[^\]]*\]|\(\+[\d,]+\)|\(-[\d,]+\))/g;

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colorOf(token) {
  if (token === "HIGH") return COLORS.high;
  if (token === "MEDIUM") return COLORS.medium;
  if (token === "low") return COLORS.low;
  if (token === "karma" || token === "subscribers" || token === "signed in") return COLORS.counts;
  if (token === "pass" || token === "inbox") return COLORS.pass;
  if (token.startsWith("u/")) return COLORS.user;
  if (token.startsWith("r/")) return COLORS.community;
  if (token.startsWith("https://")) return COLORS.link;
  if (token.startsWith("[")) return COLORS.reasons;
  if (token.startsWith("(+")) return COLORS.up;
  if (token.startsWith("(-")) return COLORS.down;
  return COLORS.dim;
}

function spans(line) {
  const time = line.slice(0, 5);
  const rest = line.slice(5);
  const parts = [`<tspan fill="${COLORS.dim}">${escape(time)}</tspan>`];
  let last = 0;
  for (const match of rest.matchAll(TOKEN)) {
    if (match.index > last) parts.push(escape(rest.slice(last, match.index)));
    parts.push(`<tspan fill="${colorOf(match[0])}">${escape(match[0])}</tspan>`);
    last = match.index + match[0].length;
  }
  parts.push(escape(rest.slice(last)));
  return parts.join("");
}

// A pass line carries its notes on the lines under it.
const rowsText = lines.flatMap((line) => line.split("\n"));
const FONT_SIZE = 14;
const LINE = 26;
const CHAR = FONT_SIZE * 0.6;
const PAD = 28;
const BAR = 40;
const command = "$ reddit-monitor run --profile acme --keywords acme --communities selfhosted,webdev,sysadmin";
const longest = Math.max(command.length, ...rowsText.map((line) => line.length));
const width = Math.ceil(PAD * 2 + longest * CHAR);
const height = BAR + PAD + LINE * (rowsText.length + 1) + PAD - 6;

const rows = [
  `<text x="${PAD}" y="${BAR + PAD + 4}"><tspan fill="${COLORS.prompt}">$</tspan> ${escape(command.slice(2))}</text>`,
  ...rowsText.map((line, index) => `<text x="${PAD}" y="${BAR + PAD + 4 + LINE * (index + 1)}" xml:space="preserve">${spans(line)}</text>`),
];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Example reddit-monitor output: mentions and keyword matches ranked by urgency, and karma and subscriber changes">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${COLORS.background}" stroke="${COLORS.border}"/>
  <path d="M12.5 0.5h${width - 25}a12 12 0 0 1 12 12v${BAR - 12}h-${width - 1}v-${BAR - 12}a12 12 0 0 1 12-12z" fill="${COLORS.bar}"/>
  <circle cx="24" cy="20" r="6" fill="#ff5f57"/>
  <circle cx="44" cy="20" r="6" fill="#febc2e"/>
  <circle cx="64" cy="20" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="25" text-anchor="middle" fill="${COLORS.dim}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="13">reddit-monitor — sample output</text>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}" fill="${COLORS.text}">
    ${rows.join("\n    ")}
  </g>
</svg>
`;

await writeFile(new URL("../assets/reddit-monitor-terminal.svg", import.meta.url), svg);
console.log(`assets/reddit-monitor-terminal.svg: ${width}x${height}, ${rowsText.length} lines`);
