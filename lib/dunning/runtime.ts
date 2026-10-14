import "server-only";
import type { Db } from "@/lib/db/core";
import { getEmailClient } from "@/lib/email";
import { publicEnv, serverEnv } from "@/lib/env";
import { getStripeResolver } from "@/lib/stripe/client";
import type { CardUpdateDeps } from "./card-update";
import { createDunningRepo } from "./repo";
import { companyNameFor, type SequenceDeps } from "./service";
import { createCardUpdateStripe, createDunningStripe } from "./stripe-ops";
import type { CaseWithAccount } from "./types";

/** Real dependencies for the email sequence (cron + webhook). */
export function sequenceDeps(db: Db): SequenceDeps {
  const email = getEmailClient();
  const fromAddress = serverEnv.emailFromAddress();
  if (email.live && !fromAddress) {
    throw new Error("EMAIL_FROM_ADDRESS is not set. Add an address on your Resend-verified domain, e.g. billing@mail.yourdomain.com.");
  }
  return {
    repo: createDunningRepo(db),
    stripe: createDunningStripe(getStripeResolver(db)),
    email,
    config: { appUrl: publicEnv.appUrl(), linkSecret: serverEnv.dunningLinkSecret(), fromAddress },
    log: (line) => console.info(line),
  };
}

/** Real dependencies for the card-update page and its API. */
export function cardUpdateDeps(db: Db): CardUpdateDeps {
  return {
    repo: createDunningRepo(db),
    stripe: createCardUpdateStripe(getStripeResolver(db)),
    linkSecret: serverEnv.dunningLinkSecret(),
  };
}

/** The company name customers see, from the founder's dunning settings. */
export function companyResolver(db: Db) {
  const repo = createDunningRepo(db);
  return async (c: CaseWithAccount) => companyNameFor(await repo.getSettings(c.account_id), c.account);
}
