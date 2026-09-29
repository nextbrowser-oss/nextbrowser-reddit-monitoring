// When the next pass should run. The caller owns the timer — the app has its
// own scheduler, the CLI a loop — and this only says how long to wait.

/** The shortest interval between passes. Every pass is a handful of requests
 *  to reddit.com on the account's own session; faster is not monitoring, it
 *  is load, and it spends the account's rate limit. */
export const MIN_INTERVAL_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 10 * 60_000;
/** How far one wait may stray from the interval, either way. A session that
 *  asks for the same listings every 600.0 seconds is a clock, not a person. */
const JITTER = 0.2;

/** scheduleDelay is the interval with a random spread, never under the
 *  minimum. A pass reddit.com refused or rate-limited waits longer: asking
 *  again at once only extends the refusal. */
export function scheduleDelay(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  options: { random?: () => number; backOff?: boolean } = {},
): number {
  const random = options.random ?? Math.random;
  const base = Math.max(MIN_INTERVAL_MS, Number.isFinite(intervalMs) ? intervalMs : DEFAULT_INTERVAL_MS);
  const spread = 1 + JITTER * (2 * random() - 1);
  const delay = Math.round(base * spread * (options.backOff ? 3 : 1));
  return Math.max(MIN_INTERVAL_MS, delay);
}
