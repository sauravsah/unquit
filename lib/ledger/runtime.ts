import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createBillingRepo, ownerEmail } from "@/lib/billing/repo";
import type { BillingDeps } from "@/lib/billing/service";
import { createBillingStripe } from "@/lib/billing/stripe-ops";
import { getEmailClient } from "@/lib/email";
import { publicEnv, serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe/client";
import type { FounderMailer, LedgerDeps } from "./disputes";
import { createLedgerRepo } from "./repo";
import { createEvidenceStripe } from "./stripe-ops";

/** "unquit" <billing@…>: founder-facing emails come from unquit itself. */
function fromLine(): string {
  const address = serverEnv.emailFromAddress() || "billing@example.invalid";
  return `"unquit" <${address}>`;
}

/** Sends founder and admin emails through Resend (or logs them without RESEND_API_KEY). */
export function createFounderMailer(admin: SupabaseClient): FounderMailer {
  const email = getEmailClient();
  return {
    async toFounder(accountId, message) {
      const { data, error } = await admin.from("accounts").select("owner_user_id").eq("id", accountId).maybeSingle();
      if (error) throw new Error(`Loading account owner failed: ${error.message}`);
      const to = data ? await ownerEmail(admin, data.owner_user_id as string) : null;
      if (!to) return false;
      await email.send({
        from: fromLine(),
        to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        idempotencyKey: message.idempotencyKey,
        tags: { kind: "founder" },
      });
      return true;
    },
    async toAdmins(message) {
      for (const to of serverEnv.adminEmails()) {
        await email.send({
          from: fromLine(),
          to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          idempotencyKey: `${message.idempotencyKey}/${to}`,
          tags: { kind: "admin" },
        });
      }
    },
  };
}

/** Real dependencies for receipts, disputes and the daily ledger jobs. */
export function ledgerDeps(admin: SupabaseClient): LedgerDeps {
  return {
    repo: createLedgerRepo(admin),
    stripe: createEvidenceStripe(getStripe()),
    mailer: createFounderMailer(admin),
    appUrl: publicEnv.appUrl(),
    log: (line) => console.info(line),
  };
}

/** Real dependencies for unquit's own monthly billing (platform Stripe account). */
export function billingDeps(admin: SupabaseClient): BillingDeps {
  return {
    repo: createBillingRepo(admin),
    stripe: createBillingStripe(getStripe()),
    appUrl: publicEnv.appUrl(),
    log: (line) => console.info(line),
  };
}
