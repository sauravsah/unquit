import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEmailClient } from "@/lib/email";
import { publicEnv, serverEnv } from "@/lib/env";
import { getStripe } from "@/lib/stripe/client";
import type { CardUpdateDeps } from "./card-update";
import { createDunningRepo } from "./repo";
import { companyNameFor, type SequenceDeps } from "./service";
import { createCardUpdateStripe, createDunningStripe } from "./stripe-ops";
import type { CaseWithAccount } from "./types";

/** Real dependencies for the email sequence (cron + webhook). */
export function sequenceDeps(admin: SupabaseClient): SequenceDeps {
  const email = getEmailClient();
  const fromAddress = serverEnv.emailFromAddress();
  if (email.live && !fromAddress) {
    throw new Error("EMAIL_FROM_ADDRESS is not set. Add an address on your Resend-verified domain, e.g. billing@mail.yourdomain.com.");
  }
  return {
    repo: createDunningRepo(admin),
    stripe: createDunningStripe(getStripe()),
    email,
    config: { appUrl: publicEnv.appUrl(), linkSecret: serverEnv.dunningLinkSecret(), fromAddress },
    log: (line) => console.info(line),
  };
}

/** Real dependencies for the card-update page and its API. */
export function cardUpdateDeps(admin: SupabaseClient): CardUpdateDeps {
  return {
    repo: createDunningRepo(admin),
    stripe: createCardUpdateStripe(getStripe()),
    linkSecret: serverEnv.dunningLinkSecret(),
  };
}

/** The company name customers see, from the founder's dunning settings. */
export function companyResolver(admin: SupabaseClient) {
  const repo = createDunningRepo(admin);
  return async (c: CaseWithAccount) => companyNameFor(await repo.getSettings(c.account_id), c.account);
}
