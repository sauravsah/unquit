import "server-only";
import { attempt, queryOne, type Db } from "@/lib/db/core";
import { createBillingRepo, ownerEmail } from "@/lib/billing/repo";
import type { BillingDeps, ChargeCollector } from "@/lib/billing/service";
import { getEmailClient } from "@/lib/email";
import { publicEnv, serverEnv } from "@/lib/env";
import { getStripeResolver } from "@/lib/stripe/client";
import type { FounderMailer, LedgerDeps } from "./disputes";
import { createLedgerRepo } from "./repo";
import { createEvidenceStripe } from "./stripe-ops";

/** "unquit" <billing@…>: founder-facing emails come from unquit itself. */
function fromLine(): string {
  const address = serverEnv.emailFromAddress() || "billing@example.invalid";
  return `"unquit" <${address}>`;
}

/** Sends founder and admin emails through Resend (or logs them without RESEND_API_KEY). */
export function createFounderMailer(db: Db): FounderMailer {
  const email = getEmailClient();
  return {
    async toFounder(accountId, message) {
      const data = await attempt("Loading account owner", () =>
        queryOne<{ owner_user_id: string }>(db, "select owner_user_id from accounts where id = $1", [accountId]),
      );
      const to = data ? await ownerEmail(db, data.owner_user_id) : null;
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
export function ledgerDeps(db: Db): LedgerDeps {
  return {
    repo: createLedgerRepo(db),
    stripe: createEvidenceStripe(getStripeResolver(db)),
    mailer: createFounderMailer(db),
    appUrl: publicEnv.appUrl(),
    log: (line) => console.info(line),
  };
}

/**
 * Real dependencies for unquit's own monthly billing: statements close on the
 * 1st and are charged to the founder's card through Dodo Payments.
 */
export function billingDeps(db: Db, collector: ChargeCollector): BillingDeps {
  return {
    repo: createBillingRepo(db),
    collector,
    appUrl: publicEnv.appUrl(),
    log: (line) => console.info(line),
  };
}
