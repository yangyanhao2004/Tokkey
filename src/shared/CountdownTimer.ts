/** Calculates a stable countdown from a deadline so delayed UI ticks cannot accumulate drift. */
export default class CountdownTimer {
  readonly durationSeconds: number;

  constructor(durationSeconds: number) {
    if (!Number.isInteger(durationSeconds) || durationSeconds <= 0) {
      throw new Error('Countdown duration must be a positive integer.');
    }
    this.durationSeconds = durationSeconds;
  }

  /** Starts a new countdown and returns its absolute deadline in milliseconds. */
  start(nowMs: number = Date.now()): number {
    return nowMs + this.durationSeconds * 1_000;
  }

  /** Returns whole display seconds, rounding up until the deadline has passed. */
  getSecondsRemaining(deadlineMs: number, nowMs: number = Date.now()): number {
    return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
  }
}
