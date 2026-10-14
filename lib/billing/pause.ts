/**
 * Pausing a founder whose Unquit bill is unpaid, and resuming them.
 *
 *            statement unpaid after the final retry
 *            (or a hard decline with no new card)
 *   active ───────────────────────────────────────▶ warned ── 3 days, still unpaid ──▶ paused (auto)
 *     ▲         email: "Unquit will pause in 3 days      │      email: "Unquit is paused"   │
 *     │                 unless the card is updated"      │                                  │
 *     │                                                  │ paid before the 3 days end       │ outstanding statement paid
 *     ├──────────────────────────────────────────────────┘ (no email)                       │ (Dodo payment.succeeded,
 *     │                                                                                     │  incl. right after a card update)
 *     └─────────────────────────────────────────────────────────────────────────────────────┘ email: "Unquit is back on"
 *
 *   Admin: pause any account (source "admin", only an admin resumes it) or
 *   resume any account (clears a warning too).
 *
 * While paused (lib/widget/service.ts, lib/dunning/service.ts):
 *   • the cancel-flow widget shows no offers; the survey goes straight to the
 *     cancel confirmation, and Unquit still cancels the subscription, so an end
 *     customer is NEVER blocked from cancelling;
 *   • no dunning emails are sent and the sequence starts no retries for the
 *     founder's customers (the hosted card-update page from an earlier email
 *     keeps working: blocking a customer who is trying to pay helps nobody);
 *   • webhooks keep recording fee windows, recoveries and evidence, so
 *     nothing is lost.
 *
 * "Outstanding" = a charge that went unpaid at some point (unpaid_at set) and
 * has not been paid since. A card update moves it back to "scheduled", which
 * is still outstanding until the payment succeeds.
 *
 * Every transition is a compare-and-set on billing_pause_state, so webhooks,
 * the daily cron and admins can race without double emails. Emails are
 * best-effort (never fail the caller; without Resend they are only logged).
 */
import { attempt, queryOne, type Db } from "@/lib/db/core";
import type { RenderedEmail } from "@/lib/ledger/emails";
import { accountPausedEmail, accountResumedEmail, paymentUnpaidEmail } from "./dodo/emails";

export const PAUSE_GRACE_DAYS = 3;
const DAY_MS = 86_400_000;
/** The daily cron runs at 06:00 UTC; a pause due a little after that still happens that morning. */
const DUE_SLACK_MS = 2 * 60 * 60_000;

export type PauseState = "active" | "warned" | "paused";
export type PauseSource = "auto" | "admin";

export type PauseRow = {
  id: string;
  billing_pause_state: PauseState;
  billing_pause_source: PauseSource | null;
  billing_pause_warned_at: string | null;
  billing_pause_due_at: string | null;
  billing_paused_at: string | null;
  billing_resumed_at: string | null;
  billing_pause_warning_emailed_at: string | null;
  billing_pause_emailed_at: string | null;
  billing_resume_emailed_at: string | null;
};

export const PAUSE_COLUMNS =
  "id, billing_pause_state, billing_pause_source, billing_pause_warned_at, billing_pause_due_at, billing_paused_at, billing_resumed_at, billing_pause_warning_emailed_at, billing_pause_emailed_at, billing_resume_emailed_at";

export type PauseDeps = {
  db: Db;
  appUrl: string;
  mailer?: { toFounder(accountId: string, email: RenderedEmail & { idempotencyKey: string }): Promise<boolean> };
  now?: () => Date;
  log?: (line: string) => void;
};

export type OutstandingCharge = { id: string; status: string; amount_cents: number; unpaid_at: string };

// -----------------------------------------------------------------------------
// Pure decisions
// -----------------------------------------------------------------------------

export type SweepAction = "none" | "warn" | "pause" | "clear_warning" | "resume";

/**
 * What the daily sweep does with one account. `outstanding` are its
 * unpaid-at-some-point charges not yet paid; `inFlight` is true when one of
 * them is being charged right now.
 */
export function decideSweep(
  row: Pick<PauseRow, "billing_pause_state" | "billing_pause_source" | "billing_pause_due_at" | "billing_resumed_at">,
  outstanding: readonly Pick<OutstandingCharge, "status" | "unpaid_at">[],
  now: Date,
): SweepAction {
  const owing = outstanding.length > 0;
  switch (row.billing_pause_state) {
    case "active": {
      // Safety net for a missed warning: a charge that went unpaid since the last resume.
      const since = row.billing_resumed_at ? Date.parse(row.billing_resumed_at) : -Infinity;
      return outstanding.some((c) => c.status === "unpaid" && Date.parse(c.unpaid_at) > since) ? "warn" : "none";
    }
    case "warned": {
      if (!owing) return "clear_warning";
      const due = row.billing_pause_due_at ? Date.parse(row.billing_pause_due_at) : 0;
      if (due > now.getTime() + DUE_SLACK_MS) return "none";
      // A payment is in flight (e.g. right after a card update): wait for its outcome.
      if (outstanding.some((c) => c.status === "processing")) return "none";
      return "pause";
    }
    case "paused":
      return row.billing_pause_source === "auto" && !owing ? "resume" : "none";
    default:
      return "none";
  }
}

export function pauseDueAt(warnedAt: Date): Date {
  return new Date(warnedAt.getTime() + PAUSE_GRACE_DAYS * DAY_MS);
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();
const billingUrl = (appUrl: string) => `${appUrl}/dashboard/billing`;

export async function loadPause(db: Db, accountId: string): Promise<PauseRow | null> {
  return attempt("Loading pause state", () => queryOne<PauseRow>(db, `select ${PAUSE_COLUMNS} from accounts where id = $1`, [accountId]));
}

/** True while the account is paused (offers off, no dunning). Fails OPEN: an error reads as "not paused". */
export async function isAccountPaused(db: Db, accountId: string): Promise<boolean> {
  try {
    const row = await queryOne<{ paused: boolean }>(db, "select billing_pause_state = 'paused' as paused from accounts where id = $1", [accountId]);
    return !!row?.paused;
  } catch {
    return false;
  }
}

export async function outstandingCharges(db: Db, accountId: string): Promise<OutstandingCharge[]> {
  return attempt("Loading outstanding charges", () =>
    db.query<OutstandingCharge>(
      `select id, status, amount_cents, unpaid_at from billing_charges
        where account_id = $1 and unpaid_at is not null and status not in ('paid', 'refunded', 'partially_refunded')
        order by unpaid_at asc`,
      [accountId],
    ),
  );
}

const sumCents = (rows: readonly { amount_cents: number }[]) => rows.reduce((a, r) => a + Number(r.amount_cents), 0);

async function notify(deps: PauseDeps, accountId: string, email: RenderedEmail, key: string): Promise<boolean> {
  if (!deps.mailer) return false;
  try {
    return await deps.mailer.toFounder(accountId, { ...email, idempotencyKey: key });
  } catch (error) {
    deps.log?.(`[billing/pause] email to founder ${accountId} failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Transitions (compare-and-set on the state)
// -----------------------------------------------------------------------------

/**
 * active -> warned. Returns the pause date when THIS call started the warning
 * (the caller sends the warning email), null when the account was already
 * warned or paused.
 */
export async function startWarning(deps: PauseDeps, accountId: string): Promise<Date | null> {
  const now = nowOf(deps);
  const due = pauseDueAt(now);
  const rows = await attempt("Starting pause warning", () =>
    deps.db.query<{ id: string }>(
      `update accounts
          set billing_pause_state = 'warned', billing_pause_warned_at = $2, billing_pause_due_at = $3, billing_pause_warning_emailed_at = null
        where id = $1 and billing_pause_state = 'active'
        returning id`,
      [accountId, now.toISOString(), due.toISOString()],
    ),
  );
  return rows.length > 0 ? due : null;
}

export async function markWarningEmailed(db: Db, accountId: string, at: Date): Promise<void> {
  await db.query("update accounts set billing_pause_warning_emailed_at = $2 where id = $1", [accountId, at.toISOString()]);
}

/** warned (or active, for an admin) -> paused, then the pause email. True if this call paused it. */
export async function pauseAccount(deps: PauseDeps, accountId: string, source: PauseSource): Promise<boolean> {
  const now = nowOf(deps);
  const from = source === "admin" ? ["active", "warned"] : ["warned"];
  const rows = await attempt("Pausing account", () =>
    deps.db.query<{ id: string }>(
      `update accounts
          set billing_pause_state = 'paused', billing_pause_source = $2, billing_paused_at = $3, billing_pause_emailed_at = null
        where id = $1 and billing_pause_state = any($4::text[])
        returning id`,
      [accountId, source, now.toISOString(), from],
    ),
  );
  if (rows.length === 0) return false;
  const owing = sumCents(await outstandingCharges(deps.db, accountId).catch(() => []));
  const sent = await notify(
    deps,
    accountId,
    accountPausedEmail({ amountCents: owing, billingUrl: billingUrl(deps.appUrl), byAdmin: source === "admin" }),
    `unquit-pause/${accountId}/paused/${now.toISOString()}`,
  );
  if (sent) await deps.db.query("update accounts set billing_pause_emailed_at = $2 where id = $1", [accountId, now.toISOString()]);
  deps.log?.(`[billing/pause] ${accountId} paused (${source})`);
  return true;
}

/**
 * warned/paused -> active. An automatic resume needs nothing outstanding and
 * never lifts an admin's pause. Emails "Unquit is back on" only when the
 * account was actually paused. True if this call resumed it.
 */
export async function resumeAccount(deps: PauseDeps, accountId: string, by: "payment" | "admin"): Promise<boolean> {
  const now = nowOf(deps);
  if (by === "payment" && (await outstandingCharges(deps.db, accountId)).length > 0) return false;
  const rows = await attempt("Resuming account", () =>
    deps.db.query<{ was: PauseState }>(
      `update accounts a
          set billing_pause_state = 'active', billing_pause_source = null, billing_pause_due_at = null,
              billing_resumed_at = $2, billing_resume_emailed_at = null
         from (select id, billing_pause_state as was from accounts where id = $1) old
        where a.id = old.id
          and (a.billing_pause_state = 'warned' or (a.billing_pause_state = 'paused' and ($3::boolean or a.billing_pause_source = 'auto')))
        returning old.was`,
      [accountId, now.toISOString(), by === "admin"],
    ),
  );
  const was = rows[0]?.was;
  if (!was) return false;
  if (was === "paused") {
    const sent = await notify(deps, accountId, accountResumedEmail({ billingUrl: billingUrl(deps.appUrl) }), `unquit-pause/${accountId}/resumed/${now.toISOString()}`);
    if (sent) await deps.db.query("update accounts set billing_resume_emailed_at = $2 where id = $1", [accountId, now.toISOString()]);
  }
  deps.log?.(`[billing/pause] ${accountId} resumed (${by}, was ${was})`);
  return true;
}

/** Called after a payment succeeded: resumes the account if that was the last outstanding statement. */
export async function resumeIfSettled(deps: PauseDeps, accountId: string): Promise<boolean> {
  const row = await loadPause(deps.db, accountId);
  if (!row || row.billing_pause_state === "active") return false;
  return resumeAccount(deps, accountId, "payment");
}

export type SweepSummary = { checked: number; warned: number; paused: number; resumed: number; cleared: number; failed: number };

/**
 * The daily sweep (after the retry run): pauses accounts whose grace period
 * ended, resumes any whose bill was paid but missed the webhook, and starts a
 * warning that a crash skipped. Safe to run any number of times.
 */
export async function runPauseSweep(deps: PauseDeps): Promise<SweepSummary> {
  const now = nowOf(deps);
  const summary: SweepSummary = { checked: 0, warned: 0, paused: 0, resumed: 0, cleared: 0, failed: 0 };
  const candidates = await attempt("Loading accounts to sweep", () =>
    deps.db.query<PauseRow>(
      `select ${PAUSE_COLUMNS} from accounts a
        where a.billing_pause_state <> 'active'
           or exists (select 1 from billing_charges c
                       where c.account_id = a.id and c.status = 'unpaid'
                         and c.unpaid_at > coalesce(a.billing_resumed_at, '-infinity'::timestamptz))
        limit 500`,
    ),
  );
  for (const row of candidates) {
    summary.checked++;
    try {
      const outstanding = await outstandingCharges(deps.db, row.id);
      const action = decideSweep(row, outstanding, now);
      if (action === "warn") {
        const due = await startWarning(deps, row.id);
        if (due) {
          await sendWarning(deps, row.id, outstanding, due);
          summary.warned++;
        }
      } else if (action === "pause") {
        if (await pauseAccount(deps, row.id, "auto")) summary.paused++;
      } else if (action === "resume") {
        if (await resumeAccount(deps, row.id, "payment")) summary.resumed++;
      } else if (action === "clear_warning") {
        if (await resumeAccount(deps, row.id, "payment")) summary.cleared++;
      }
    } catch (error) {
      summary.failed++;
      deps.log?.(`[billing/pause] sweep of ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}

async function sendWarning(deps: PauseDeps, accountId: string, outstanding: readonly OutstandingCharge[], due: Date): Promise<void> {
  const now = nowOf(deps);
  const sent = await notify(
    deps,
    accountId,
    paymentUnpaidEmail({
      amountCents: sumCents(outstanding),
      periodLabel: "your earlier statement",
      reason: "The payment didn't go through.",
      billingUrl: billingUrl(deps.appUrl),
      pause: { kind: "warning", pauseOn: due },
    }),
    `unquit-pause/${accountId}/warning/${due.toISOString()}`,
  );
  if (sent) await markWarningEmailed(deps.db, accountId, now);
}

// -----------------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------------

export type PauseBanner = { state: "warned"; pauseOn: string } | { state: "paused"; byAdmin: boolean } | null;

/** What the dashboard banner shows. Never throws. */
export async function pauseBannerFor(db: Db, accountId: string): Promise<PauseBanner> {
  try {
    const row = await loadPause(db, accountId);
    if (!row) return null;
    if (row.billing_pause_state === "paused") return { state: "paused", byAdmin: row.billing_pause_source === "admin" };
    if (row.billing_pause_state === "warned" && row.billing_pause_due_at) return { state: "warned", pauseOn: row.billing_pause_due_at };
    return null;
  } catch {
    return null;
  }
}

export type AdminPauseView = PauseRow & { name: string | null; owner_email: string | null; outstanding_cents: number };

/** Accounts that are warned or paused (admin only: deliberately not scoped to one account). */
export async function adminPauses(db: Db): Promise<AdminPauseView[]> {
  return attempt("Loading paused accounts", () =>
    db.query<AdminPauseView>(
      `select ${PAUSE_COLUMNS.split(", ").map((c) => `a.${c}`).join(", ")}, a.name, u.email as owner_email,
              coalesce((select sum(c.amount_cents) from billing_charges c
                         where c.account_id = a.id and c.unpaid_at is not null
                           and c.status not in ('paid', 'refunded', 'partially_refunded')), 0)::bigint as outstanding_cents
         from accounts a left join users u on u.id = a.owner_user_id
        where a.billing_pause_state <> 'active'
        order by coalesce(a.billing_paused_at, a.billing_pause_warned_at) desc
        limit 200`,
    ),
  );
}

/** An account id from an id or the owner's email (admin form). */
export async function findAccountForAdmin(db: Db, idOrEmail: string): Promise<string | null> {
  const v = idOrEmail.trim();
  if (/^[0-9a-f-]{36}$/i.test(v)) {
    const row = await queryOne<{ id: string }>(db, "select id from accounts where id = $1", [v]);
    return row?.id ?? null;
  }
  if (!v.includes("@")) return null;
  const row = await queryOne<{ id: string }>(db, "select a.id from accounts a join users u on u.id = a.owner_user_id where lower(u.email) = lower($1) limit 1", [v]);
  return row?.id ?? null;
}
