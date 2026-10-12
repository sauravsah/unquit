/**
 * The email sequence scheduler, as pure functions.
 *
 * A dunning case sends at most 3 emails, on the days in the founder's
 * schedule (default day 0, 3 and 7 after the failed payment). The cron calls
 * `decideSequenceAction` for each due case; the sequence stops the moment the
 * invoice is paid or closed, or the subscription is cancelled.
 */

export const SEQUENCE_LENGTH = 3;
export const DEFAULT_SCHEDULE_DAYS: readonly [number, number, number] = [0, 3, 7];
export const MAX_SCHEDULE_DAY = 60;
/** Never send two emails closer together than this (e.g. after the cron was down). */
export const MIN_GAP_MS = 12 * 60 * 60 * 1000;
/** Cases older than this get no (more) emails, e.g. when a founder switches dunning on late. */
export const MAX_CASE_AGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ScheduleDays = readonly [number, number, number];

export type StopReason = "paid" | "canceled" | "completed" | "no_email" | "invoice_closed";

export type SequenceCase = {
  status: "open" | "recovered" | "failed" | "closed";
  sequence_step: number; // emails already sent (0..3)
  next_email_at: string | null;
  customer_email: string | null;
  opened_at: string;
};

/** What Stripe says right now. `null` fields mean "unknown" (don't stop on them). */
export type LiveState = {
  invoiceStatus: string | null; // draft | open | paid | void | uncollectible | deleted
  subscriptionStatus: string | null; // active | past_due | canceled | ...
};

export type SequenceAction =
  | { action: "send"; step: number }
  | { action: "stop"; reason: StopReason }
  | { action: "wait" }
  | { action: "skip" }; // case is no longer open: nothing to do

const CLOSED_INVOICE = new Set(["void", "uncollectible", "deleted"]);
const ENDED_SUBSCRIPTION = new Set(["canceled", "incomplete_expired"]);

export function isValidSchedule(days: unknown): days is ScheduleDays {
  return (
    Array.isArray(days) &&
    days.length === SEQUENCE_LENGTH &&
    days.every((d) => Number.isInteger(d) && d >= 0 && d <= MAX_SCHEDULE_DAY) &&
    days[0] < days[1] &&
    days[1] < days[2]
  );
}

/** When email `step` (0-based) is due on the plain schedule. */
export function scheduledAt(openedAt: Date, schedule: ScheduleDays, step: number): Date {
  const days = schedule[step];
  if (days === undefined) throw new RangeError(`No email ${step} in a ${SEQUENCE_LENGTH}-email sequence`);
  return new Date(openedAt.getTime() + days * DAY_MS);
}

/** When the first email goes out for a newly opened case. */
export function firstEmailAt(openedAt: Date, schedule: ScheduleDays): Date {
  return scheduledAt(openedAt, schedule, 0);
}

/**
 * After email `sentStep` went out at `now`: when the next one is due, or null
 * when the sequence is complete. Keeps at least MIN_GAP_MS between emails so a
 * late cron run never sends two back to back.
 */
export function nextEmailAfter(sentStep: number, openedAt: Date, schedule: ScheduleDays, now: Date): Date | null {
  const next = sentStep + 1;
  if (next >= SEQUENCE_LENGTH) return null;
  const planned = scheduledAt(openedAt, schedule, next).getTime();
  return new Date(Math.max(planned, now.getTime() + MIN_GAP_MS));
}

/** Decides what the cron does with one case. */
export function decideSequenceAction(c: SequenceCase, live: LiveState | null, now: Date): SequenceAction {
  if (c.status !== "open") return { action: "skip" };

  if (live) {
    if (live.invoiceStatus === "paid") return { action: "stop", reason: "paid" };
    if (live.invoiceStatus && CLOSED_INVOICE.has(live.invoiceStatus)) return { action: "stop", reason: "invoice_closed" };
    if (live.subscriptionStatus && ENDED_SUBSCRIPTION.has(live.subscriptionStatus)) return { action: "stop", reason: "canceled" };
  }

  if (c.sequence_step >= SEQUENCE_LENGTH) return { action: "stop", reason: "completed" };
  if (now.getTime() - Date.parse(c.opened_at) > MAX_CASE_AGE_DAYS * DAY_MS) return { action: "stop", reason: "completed" };
  if (!c.customer_email) return { action: "stop", reason: "no_email" };
  if (!c.next_email_at || Date.parse(c.next_email_at) > now.getTime()) return { action: "wait" };

  return { action: "send", step: c.sequence_step };
}

/** Subscription statuses that end a dunning sequence when seen on a webhook. */
export function subscriptionEndsDunning(status: string): boolean {
  return ENDED_SUBSCRIPTION.has(status);
}
