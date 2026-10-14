/** 0008_restricted_key_mode.sql: restricted-key connections and their encrypted secrets. */
import { beforeAll, describe, expect, it } from "vitest";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";

let db: TestDb;
const CT = "v1.aaaa.bbbb.cccc";

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);

describe("accounts: restricted-key mode", () => {
  it("defaults existing and new accounts to Stripe Connect", async () => {
    const { accountId } = await addFounder(db, { stripe: "acct_default" });
    expect(await db.value(`select stripe_connection_mode from accounts where id = '${accountId}'`)).toBe("connect");
    expect(await db.fails(`update accounts set stripe_connection_mode = 'oauth' where id = '${accountId}'`)).toBe(true);
  });

  it("a connected key-mode account must have its encrypted key, webhook secret and last 4", async () => {
    const { accountId } = await addFounder(db, { stripe: "acct_keyed" });
    expect(await db.fails(`update accounts set stripe_connection_mode = 'key' where id = '${accountId}'`)).toBe(true);
    await db.exec(
      `update accounts set stripe_connection_mode = 'key', stripe_key_ciphertext = '${CT}', stripe_webhook_secret_ciphertext = '${CT}',
              stripe_key_last4 = 'WXYZ', stripe_publishable_key = 'pk_test_abc123', stripe_webhook_endpoint_id = 'we_1'
        where id = '${accountId}'`,
    );
    // Disconnecting may wipe them.
    await db.exec(
      `update accounts set stripe_connection_status = 'disconnected', stripe_key_ciphertext = null, stripe_webhook_secret_ciphertext = null,
              stripe_key_last4 = null, stripe_publishable_key = null, stripe_webhook_endpoint_id = null
        where id = '${accountId}'`,
    );
    expect(await db.value(`select stripe_key_ciphertext from accounts where id = '${accountId}'`)).toBeNull();
  });

  it("refuses plain-text keys in the ciphertext columns and junk publishable keys", async () => {
    const { accountId } = await addFounder(db);
    expect(await db.fails(`update accounts set stripe_key_ciphertext = 'rk_live_plaintext' where id = '${accountId}'`)).toBe(true);
    expect(await db.fails(`update accounts set stripe_webhook_secret_ciphertext = 'whsec_plain' where id = '${accountId}'`)).toBe(true);
    expect(await db.fails(`update accounts set stripe_publishable_key = 'sk_live_oops' where id = '${accountId}'`)).toBe(true);
    expect(await db.fails(`update accounts set stripe_key_last4 = 'TOOLONG' where id = '${accountId}'`)).toBe(true);
  });
});
