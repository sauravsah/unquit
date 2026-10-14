import "server-only";
import type { Db } from "@/lib/db/core";
import { publicEnv, serverEnv } from "@/lib/env";
import { createFounderMailer } from "@/lib/ledger/runtime";
import type { ChargeCollector } from "../service";
import { createDodoClient, type DodoClient } from "./client";
import { MIN_CHARGE_CENTS } from "./policy";
import { claimCarryIn, scheduleCharge, type DodoBillingDeps } from "./service";

let client: DodoClient | null = null;

/** The Dodo Payments client for unquit's own billing (DODO_PAYMENTS_API_KEY / _ENVIRONMENT). */
export function getDodoClient(): DodoClient {
  const environment = serverEnv.dodoEnvironment();
  if (!client || client.environment !== environment) {
    client = createDodoClient({ apiKey: serverEnv.dodoApiKey(), environment });
  }
  return client;
}

/** The Dodo environment unquit runs in, or test_mode when DODO_PAYMENTS_ENVIRONMENT is invalid (display only). */
export function dodoEnvironmentOrTest(): "test_mode" | "live_mode" {
  try {
    return serverEnv.dodoEnvironment();
  } catch {
    return "test_mode";
  }
}

/** True when every Dodo billing variable is set (the billing page degrades gracefully otherwise). */
export function dodoConfigured(): boolean {
  try {
    serverEnv.dodoApiKey();
    serverEnv.dodoUsageProductId();
    serverEnv.dodoEnvironment();
    return true;
  } catch {
    return false;
  }
}

export function dodoDeps(db: Db): DodoBillingDeps {
  return {
    db,
    dodo: getDodoClient(),
    productId: serverEnv.dodoUsageProductId(),
    appUrl: publicEnv.appUrl(),
    mailer: createFounderMailer(db),
    log: (line) => console.info(line),
  };
}

/** Closed statements become Dodo charges (lib/billing/service.ts closeForCollection). */
export function dodoCollector(db: Db): ChargeCollector {
  return {
    minChargeCents: MIN_CHARGE_CENTS,
    claimCarryIn: (accountId, periodId) => claimCarryIn(db, accountId, periodId),
    scheduleCharge: (input) => scheduleCharge(db, input),
  };
}
