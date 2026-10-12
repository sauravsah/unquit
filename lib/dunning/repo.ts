import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SETTINGS_COLUMNS, settingsFromRow, type DunningSettingsRow } from "./settings";
import { CASE_COLUMNS, type CaseAccount, type CaseWithAccount, type ClaimOutcome, type DunningCaseRow, type DunningRepo } from "./types";

const WITH_ACCOUNT = `${CASE_COLUMNS}, account:accounts!inner(id, name, stripe_account_id, stripe_connection_status)`;

type JoinedRow = DunningCaseRow & { account: CaseAccount & { stripe_connection_status: string } };

function fail(what: string, error: { message: string }): never {
  throw new Error(`${what} failed: ${error.message}`);
}

function toCase(row: JoinedRow): CaseWithAccount {
  const { account, ...rest } = row;
  return { ...rest, account: { id: account.id, name: account.name, stripe_account_id: account.stripe_account_id } };
}

/**
 * Database side of dunning, using the SERVICE-ROLE client (the webhook, the
 * cron and the public card-update page have no founder session). Every write
 * that can race is a compare-and-set or goes through a unique constraint.
 */
export function createDunningRepo(admin: SupabaseClient): DunningRepo {
  return {
    async getSettings(accountId) {
      const { data, error } = await admin.from("dunning_settings").select(SETTINGS_COLUMNS).eq("account_id", accountId).maybeSingle();
      if (error) fail("Loading dunning settings", error);
      return settingsFromRow(data as DunningSettingsRow | null);
    },

    async findCaseByInvoice(accountId, invoiceId) {
      const { data, error } = await admin
        .from("dunning_cases")
        .select(CASE_COLUMNS)
        .eq("account_id", accountId)
        .eq("stripe_invoice_id", invoiceId)
        .maybeSingle();
      if (error) fail("Loading dunning case", error);
      return data as DunningCaseRow | null;
    },

    async getCase(caseId) {
      const { data, error } = await admin.from("dunning_cases").select(WITH_ACCOUNT).eq("id", caseId).maybeSingle();
      if (error) fail("Loading dunning case", error);
      if (!data) return null;
      const row = data as unknown as JoinedRow;
      // A founder who disconnected Stripe: their links stop working.
      if (row.account.stripe_connection_status !== "connected" || !row.account.stripe_account_id) return null;
      return toCase(row);
    },

    async insertCase(row) {
      const { data, error } = await admin
        .from("dunning_cases")
        .upsert({ ...row, status: "open" }, { onConflict: "account_id,stripe_invoice_id", ignoreDuplicates: true })
        .select(CASE_COLUMNS);
      if (error) fail(`Opening dunning case for ${row.stripe_invoice_id}`, error);
      return ((data ?? [])[0] as DunningCaseRow | undefined) ?? null;
    },

    async updateOpenCase(caseId, fields) {
      const { error } = await admin.from("dunning_cases").update(fields).eq("id", caseId).eq("status", "open");
      if (error) fail(`Updating dunning case ${caseId}`, error);
    },

    async dueCases(now, limit) {
      const { data: enabled, error: settingsError } = await admin.from("dunning_settings").select("account_id").eq("enabled", true);
      if (settingsError) fail("Loading dunning settings", settingsError);
      const accountIds = (enabled ?? []).map((r) => r.account_id as string);
      if (accountIds.length === 0) return [];

      const { data, error } = await admin
        .from("dunning_cases")
        .select(WITH_ACCOUNT)
        .eq("status", "open")
        .not("next_email_at", "is", null)
        .lte("next_email_at", now.toISOString())
        .in("account_id", accountIds)
        .eq("account.stripe_connection_status", "connected")
        .order("next_email_at", { ascending: true })
        .limit(limit);
      if (error) fail("Loading due dunning cases", error);
      return ((data ?? []) as unknown as JoinedRow[]).map(toCase);
    },

    async claimEmail(input) {
      const { data, error } = await admin.rpc("dunning_claim_email", {
        p_account_id: input.accountId,
        p_case_id: input.caseId,
        p_step: input.step,
        p_category: input.category,
        p_to_email: input.toEmail,
        p_subject: input.subject,
      });
      if (error) fail("Claiming dunning email", error);
      const row = (data as { email_id: string; outcome: ClaimOutcome }[] | null)?.[0];
      if (!row) throw new Error("Claiming dunning email returned nothing");
      return { emailId: row.email_id, outcome: row.outcome };
    },

    async markEmailSent(emailId, f) {
      const { error } = await admin
        .from("dunning_emails")
        .update({ status: f.status, provider_message_id: f.providerMessageId, sent_at: f.sentAt, error: null })
        .eq("id", emailId);
      if (error) fail(`Recording email ${emailId}`, error);
    },

    async markEmailFailed(emailId, message) {
      const { error } = await admin.from("dunning_emails").update({ status: "failed", error: message }).eq("id", emailId);
      if (error) fail(`Recording failed email ${emailId}`, error);
    },

    async advanceSequence(caseId, fromStep, nextEmailAt) {
      const { data, error } = await admin
        .from("dunning_cases")
        .update({ sequence_step: fromStep + 1, next_email_at: nextEmailAt })
        .eq("id", caseId)
        .eq("status", "open")
        .eq("sequence_step", fromStep) // compare-and-set
        .select("id");
      if (error) fail(`Advancing dunning case ${caseId}`, error);
      return (data?.length ?? 0) > 0;
    },

    async stopSequence(caseId, reason, at) {
      const { error } = await admin
        .from("dunning_cases")
        .update({ next_email_at: null, sequence_stop_reason: reason, sequence_stopped_at: at })
        .eq("id", caseId);
      if (error) fail(`Stopping dunning case ${caseId}`, error);
    },

    async closeCasesForSubscription(accountId, subscriptionId, at) {
      const { data, error } = await admin
        .from("dunning_cases")
        .update({
          status: "closed",
          closed_at: at,
          next_email_at: null,
          sequence_stop_reason: "canceled",
          sequence_stopped_at: at,
          pending_attribution: null,
          pending_attribution_at: null,
        })
        .eq("account_id", accountId)
        .eq("stripe_subscription_id", subscriptionId)
        .eq("status", "open")
        .select("id");
      if (error) fail(`Closing dunning cases for ${subscriptionId}`, error);
      return data?.length ?? 0;
    },

    async setPendingAttribution(caseId, via, at) {
      const { error } = await admin
        .from("dunning_cases")
        .update({ pending_attribution: via, pending_attribution_at: at })
        .eq("id", caseId)
        .eq("status", "open");
      if (error) fail(`Marking payment attempt on ${caseId}`, error);
    },

    async clearPendingAttribution(caseId, at) {
      const { error } = await admin
        .from("dunning_cases")
        .update({ pending_attribution: null, pending_attribution_at: null })
        .eq("id", caseId)
        .eq("pending_attribution_at", at);
      if (error) fail(`Clearing payment attempt on ${caseId}`, error);
    },

    async markLinkOpened(caseId, at) {
      const first = await admin
        .from("dunning_cases")
        .update({ link_first_opened_at: at, link_last_opened_at: at })
        .eq("id", caseId)
        .is("link_first_opened_at", null)
        .select("id");
      if (first.error) fail(`Recording link open on ${caseId}`, first.error);
      if ((first.data?.length ?? 0) > 0) return;
      const { error } = await admin.from("dunning_cases").update({ link_last_opened_at: at }).eq("id", caseId);
      if (error) fail(`Recording link open on ${caseId}`, error);
    },

    async markRecovered(caseId, f) {
      const { data, error } = await admin
        .from("dunning_cases")
        .update({
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
        })
        .eq("id", caseId)
        .eq("status", "open") // compare-and-set
        .select("id");
      if (error) fail(`Recording recovery on ${caseId}`, error);
      return (data?.length ?? 0) > 0;
    },

    async upsertDunningSave(input) {
      const { error } = await admin.from("saves").upsert(
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
        { onConflict: "dunning_case_id", ignoreDuplicates: true },
      );
      if (error) fail(`Recording dunning save for ${input.caseId}`, error);

      const { data: save, error: readError } = await admin
        .from("saves")
        .select("id")
        .eq("dunning_case_id", input.caseId)
        .single();
      if (readError) fail(`Loading dunning save for ${input.caseId}`, readError);

      const { error: lineError } = await admin.from("save_fee_lines").upsert(
        {
          save_id: save.id,
          account_id: input.accountId,
          month_index: 1,
          billing_month: input.billingMonth,
          stripe_invoice_id: input.invoiceId,
          amount_cents: input.feeCents,
        },
        { onConflict: "save_id,month_index", ignoreDuplicates: true },
      );
      if (lineError) fail(`Recording fee line for ${input.caseId}`, lineError);
    },
  };
}

/** Click on an email's link (counts it; the case's first-open time is set by the page itself). */
export async function recordEmailClick(admin: SupabaseClient, emailId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("dunning_record_click", { p_email_id: emailId });
  if (error) fail("Recording click", error);
  return data === true;
}

export async function recordEmailOpen(admin: SupabaseClient, emailId: string, at: string): Promise<void> {
  const { error } = await admin.from("dunning_emails").update({ opened_at: at }).eq("id", emailId).is("opened_at", null);
  if (error) fail("Recording open", error);
}

/** Which case an email belongs to (to check a click link's email id matches its token). */
export async function emailCaseId(admin: SupabaseClient, emailId: string): Promise<string | null> {
  const { data, error } = await admin.from("dunning_emails").select("dunning_case_id").eq("id", emailId).maybeSingle();
  if (error) fail("Loading email", error);
  return (data?.dunning_case_id as string | undefined) ?? null;
}
