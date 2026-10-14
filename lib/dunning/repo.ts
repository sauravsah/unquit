import "server-only";
import { randomUUID } from "node:crypto";
import { attempt, insertStatement, prefixColumns, queryOne, run, updateStatement, upsertStatement, type Db } from "@/lib/db/core";
import { SETTINGS_COLUMNS, settingsFromRow, type DunningSettingsRow } from "./settings";
import { CASE_COLUMNS, type CaseWithAccount, type ClaimOutcome, type DunningCaseRow, type DunningRepo } from "./types";

/** A case joined to its founder account (the account columns come back prefixed). */
const WITH_ACCOUNT = `select ${prefixColumns(CASE_COLUMNS, "c")},
         a.id as account__id, a.name as account__name, a.stripe_account_id as account__stripe_account_id,
         a.stripe_connection_status as account__stripe_connection_status,
         a.stripe_connection_mode as account__stripe_connection_mode, a.stripe_publishable_key as account__stripe_publishable_key,
         (a.billing_pause_state = 'paused') as account__paused
    from dunning_cases c
    join accounts a on a.id = c.account_id`;

type JoinedRow = DunningCaseRow & {
  account__id: string;
  account__name: string | null;
  account__stripe_account_id: string | null;
  account__stripe_connection_status: string;
  account__stripe_connection_mode?: "connect" | "key";
  account__stripe_publishable_key?: string | null;
  account__paused?: boolean | null;
};

function toCase(row: JoinedRow): CaseWithAccount {
  const {
    account__id,
    account__name,
    account__stripe_account_id,
    account__stripe_connection_status: _status,
    account__stripe_connection_mode,
    account__stripe_publishable_key,
    account__paused,
    ...rest
  } = row;
  return {
    ...rest,
    account: {
      id: account__id,
      name: account__name,
      stripe_account_id: account__stripe_account_id as string,
      stripe_connection_mode: account__stripe_connection_mode ?? "connect",
      stripe_publishable_key: account__stripe_publishable_key ?? null,
      paused: account__paused === true,
    },
  };
}

/**
 * Database side of dunning (the webhook, the cron and the public card-update
 * page have no founder session; every query is scoped by the case or account
 * they resolved). Every write that can race is a compare-and-set or goes
 * through a unique constraint.
 */
export function createDunningRepo(db: Db): DunningRepo {
  const exec = async (what: string, s: { text: string; params: unknown[] }) => {
    await attempt(what, () => run(db, s));
  };

  return {
    async getSettings(accountId) {
      const row = await attempt("Loading dunning settings", () =>
        queryOne<DunningSettingsRow>(db, `select ${SETTINGS_COLUMNS} from dunning_settings where account_id = $1`, [accountId]),
      );
      return settingsFromRow(row);
    },

    async findCaseByInvoice(accountId, invoiceId) {
      return attempt("Loading dunning case", () =>
        queryOne<DunningCaseRow>(db, `select ${CASE_COLUMNS} from dunning_cases where account_id = $1 and stripe_invoice_id = $2`, [
          accountId,
          invoiceId,
        ]),
      );
    },

    async getCase(caseId) {
      const row = await attempt("Loading dunning case", () => queryOne<JoinedRow>(db, `${WITH_ACCOUNT} where c.id = $1`, [caseId]));
      if (!row) return null;
      // A founder who disconnected Stripe: their links stop working.
      if (row.account__stripe_connection_status !== "connected" || !row.account__stripe_account_id) return null;
      return toCase(row);
    },

    async insertCase(row) {
      const rows = await attempt(`Opening dunning case for ${row.stripe_invoice_id}`, () =>
        run<DunningCaseRow>(
          db,
          insertStatement("dunning_cases", { ...row, status: "open" }, { onConflictDoNothing: "account_id, stripe_invoice_id", returning: CASE_COLUMNS }),
        ),
      );
      return rows[0] ?? null;
    },

    async updateOpenCase(caseId, fields) {
      if (Object.values(fields).every((v) => v === undefined)) return;
      await exec(`Updating dunning case ${caseId}`, updateStatement("dunning_cases", fields, { id: caseId, status: "open" }));
    },

    async dueCases(now, limit) {
      const rows = await attempt("Loading due dunning cases", () =>
        db.query<JoinedRow>(
          `${WITH_ACCOUNT}
            join dunning_settings s on s.account_id = c.account_id and s.enabled
           where c.status = 'open'
             and c.next_email_at is not null
             and c.next_email_at <= $1
             and a.stripe_connection_status = 'connected'
             and a.billing_pause_state <> 'paused'
           order by c.next_email_at asc
           limit $2`,
          [now.toISOString(), limit],
        ),
      );
      return rows.map(toCase);
    },

    async claimEmail(input) {
      const row = await attempt("Claiming dunning email", () =>
        queryOne<{ email_id: string; outcome: ClaimOutcome }>(
          db,
          "select email_id, outcome from dunning_claim_email($1::uuid, $2::uuid, $3::smallint, $4::text, $5::text, $6::text)",
          [input.accountId, input.caseId, input.step, input.category, input.toEmail, input.subject],
        ),
      );
      if (!row) throw new Error("Claiming dunning email returned nothing");
      return { emailId: row.email_id, outcome: row.outcome };
    },

    async markEmailSent(emailId, f) {
      await exec(
        `Recording email ${emailId}`,
        updateStatement("dunning_emails", { status: f.status, provider_message_id: f.providerMessageId, sent_at: f.sentAt, error: null }, { id: emailId }),
      );
    },

    async markEmailFailed(emailId, message) {
      await exec(`Recording failed email ${emailId}`, updateStatement("dunning_emails", { status: "failed", error: message }, { id: emailId }));
    },

    async advanceSequence(caseId, fromStep, nextEmailAt) {
      const rows = await attempt(`Advancing dunning case ${caseId}`, () =>
        run(
          db,
          updateStatement(
            "dunning_cases",
            { sequence_step: fromStep + 1, next_email_at: nextEmailAt },
            { id: caseId, status: "open", sequence_step: fromStep }, // compare-and-set
            { returning: "id" },
          ),
        ),
      );
      return rows.length > 0;
    },

    async stopSequence(caseId, reason, at) {
      await exec(
        `Stopping dunning case ${caseId}`,
        updateStatement("dunning_cases", { next_email_at: null, sequence_stop_reason: reason, sequence_stopped_at: at }, { id: caseId }),
      );
    },

    async closeCasesForSubscription(accountId, subscriptionId, at) {
      const rows = await attempt(`Closing dunning cases for ${subscriptionId}`, () =>
        run(
          db,
          updateStatement(
            "dunning_cases",
            {
              status: "closed",
              closed_at: at,
              next_email_at: null,
              sequence_stop_reason: "canceled",
              sequence_stopped_at: at,
              pending_attribution: null,
              pending_attribution_at: null,
            },
            { account_id: accountId, stripe_subscription_id: subscriptionId, status: "open" },
            { returning: "id" },
          ),
        ),
      );
      return rows.length;
    },

    async setPendingAttribution(caseId, via, at) {
      await exec(
        `Marking payment attempt on ${caseId}`,
        updateStatement("dunning_cases", { pending_attribution: via, pending_attribution_at: at }, { id: caseId, status: "open" }),
      );
    },

    async clearPendingAttribution(caseId, at) {
      await exec(
        `Clearing payment attempt on ${caseId}`,
        updateStatement("dunning_cases", { pending_attribution: null, pending_attribution_at: null }, { id: caseId, pending_attribution_at: at }),
      );
    },

    async markLinkOpened(caseId, at) {
      // One statement: the first open is kept, the last open always moves.
      await attempt(`Recording link open on ${caseId}`, () =>
        db.query(
          `update dunning_cases
              set link_first_opened_at = coalesce(link_first_opened_at, $2),
                  link_last_opened_at = $2
            where id = $1`,
          [caseId, at],
        ),
      );
    },

    async markRecovered(caseId, f) {
      const rows = await attempt(`Recording recovery on ${caseId}`, () =>
        run(
          db,
          updateStatement(
            "dunning_cases",
            {
              status: "recovered",
              recovered_via: f.via,
              recovered_amount_cents: f.amountCents,
              recovered_at: f.at,
              link_nonce: randomUUID(), // every link for this case stops working
              next_email_at: null,
              sequence_stop_reason: "paid",
              sequence_stopped_at: f.at,
              pending_attribution: null,
              pending_attribution_at: null,
            },
            { id: caseId, status: "open" }, // compare-and-set
            { returning: "id" },
          ),
        ),
      );
      return rows.length > 0;
    },

    async upsertDunningSave(input) {
      await exec(
        `Recording dunning save for ${input.caseId}`,
        insertStatement(
          "saves",
          {
            account_id: input.accountId,
            type: "dunning",
            dunning_case_id: input.caseId,
            stripe_customer_id: input.customerId,
            stripe_subscription_id: input.subscriptionId,
            stripe_invoice_id: input.invoiceId,
            recovered_amount_cents: input.recoveredAmountCents,
            currency: input.currency,
            fee_cents: input.feeCents,
            attributed_via: input.attributedVia,
            status: "verified",
            verified_at: input.verifiedAt,
          },
          { onConflictDoNothing: "dunning_case_id" },
        ),
      );

      const save = await attempt(`Loading dunning save for ${input.caseId}`, () =>
        queryOne<{ id: string }>(db, "select id from saves where dunning_case_id = $1", [input.caseId]),
      );
      if (!save) throw new Error(`Loading dunning save for ${input.caseId} failed: not found`);

      await exec(
        `Recording fee line for ${input.caseId}`,
        insertStatement(
          "save_fee_lines",
          {
            save_id: save.id,
            account_id: input.accountId,
            month_index: 1,
            billing_month: input.billingMonth,
            stripe_invoice_id: input.invoiceId,
            amount_cents: input.feeCents,
          },
          { onConflictDoNothing: "save_id, month_index" },
        ),
      );
    },
  };
}

/** Click on an email's link (counts it; the case's first-open time is set by the page itself). */
export async function recordEmailClick(db: Db, emailId: string): Promise<boolean> {
  const row = await attempt("Recording click", () => queryOne<{ ok: boolean }>(db, "select dunning_record_click($1::uuid) as ok", [emailId]));
  return row?.ok === true;
}

export async function recordEmailOpen(db: Db, emailId: string, at: string): Promise<void> {
  await attempt("Recording open", () => db.query("update dunning_emails set opened_at = $2 where id = $1 and opened_at is null", [emailId, at]));
}

/** Which case an email belongs to (to check a click link's email id matches its token). */
export async function emailCaseId(db: Db, emailId: string): Promise<string | null> {
  const row = await attempt("Loading email", () =>
    queryOne<{ dunning_case_id: string }>(db, "select dunning_case_id from dunning_emails where id = $1", [emailId]),
  );
  return row?.dunning_case_id ?? null;
}

/** Saves (insert or replace) a founder's dunning settings. */
export async function saveDunningSettings(db: Db, accountId: string, row: DunningSettingsRow): Promise<void> {
  await attempt("Saving dunning settings", () => run(db, upsertStatement("dunning_settings", { account_id: accountId, ...row }, ["account_id"])));
}

/** A founder's settings row as stored (null = never saved). */
export async function loadDunningSettingsRow(db: Db, accountId: string): Promise<DunningSettingsRow | null> {
  return attempt("Loading dunning settings", () =>
    queryOne<DunningSettingsRow>(db, `select ${SETTINGS_COLUMNS} from dunning_settings where account_id = $1`, [accountId]),
  );
}
