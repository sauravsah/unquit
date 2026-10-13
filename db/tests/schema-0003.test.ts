/** 0003_dunning.sql: dunning cases, attribution, settings, the once-only email lock and click counting. */
import { beforeAll, describe, expect, it } from "vitest";
import { createTestDb, migrateTo, type TestDb } from "@/lib/db/testing/pglite";

let db: TestDb;
let accB = "";
let caseB = "";
let legacyCase = "";

const claim = async (caseId: string, step: number) =>
  (
    await db.query<{ email_id: string; outcome: string }>(
      `select * from dunning_claim_email($1::uuid, $2::uuid, $3::smallint, 'hard', 'c@example.com', 'Card update needed')`,
      [accB, caseId, step],
    )
  )[0]!;

beforeAll(async () => {
  db = await createTestDb({ upTo: "0002" });
  accB = await db.value<string>(
    `insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status) values (gen_random_uuid(), 'B org', 'acct_B', 'connected') returning id`,
  );
  // A week-1 case that exists BEFORE 0003 runs, recovered 'external'.
  legacyCase = await db.value<string>(`insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents, status, recovered_via)
     values ('${accB}', 'in_old', 'cus_old', 1000, 'recovered', 'external') returning id`);
  await migrateTo(db, "0004");
  caseB = await db.value<string>(`insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents, decline_code, decline_category, customer_email)
     values ('${accB}', 'in_1', 'cus_1', 4900, 'expired_card', 'hard', 'c@example.com') returning id`);
}, 60_000);

describe("dunning_cases after 0003", () => {
  it("keeps week-1 rows and gives every case its own link nonce", async () => {
    const all = await db.query<{ id: string; link_nonce: string; sequence_step: number; recovered_via: string | null }>(
      `select id, link_nonce, sequence_step, recovered_via from dunning_cases order by created_at`,
    );
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === legacyCase)!.recovered_via).toBe("external");
    expect(all[0]!.link_nonce).not.toBe(all[1]!.link_nonce);
    expect(all.every((r) => r.sequence_step === 0)).toBe(true);
  });

  it("checks decline category, attribution names and the pending-attribution pair", async () => {
    expect(await db.fails(`update dunning_cases set decline_category = 'weird' where id = '${caseB}'`)).toBe(true);
    expect(await db.fails(`update dunning_cases set recovered_via = 'unquit_link' where id = '${caseB}'`)).toBe(true);
    expect(await db.fails(`update dunning_cases set sequence_step = 4 where id = '${caseB}'`)).toBe(true);
    expect(await db.fails(`update dunning_cases set pending_attribution = 'update_link' where id = '${caseB}'`)).toBe(true);
    await db.exec(`update dunning_cases set pending_attribution = 'update_link', pending_attribution_at = now() where id = '${caseB}'`);
    await db.exec(`update dunning_cases set pending_attribution = null, pending_attribution_at = null where id = '${caseB}'`);
  });

  it("allows one case per invoice per account", async () => {
    expect(
      await db.fails(`insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents) values ('${accB}', 'in_1', 'cus_1', 1)`),
    ).toBe(true);
  });
});

describe("saves.attributed_via", () => {
  it("requires an attribution on dunning saves and forbids it on cancel saves", async () => {
    const base = `insert into saves (account_id, type, dunning_case_id, stripe_customer_id, recovered_amount_cents, fee_cents, status, verified_at`;
    expect(await db.fails(`${base}) values ('${accB}', 'dunning', '${caseB}', 'cus_1', 4900, 490, 'verified', now())`)).toBe(true);
    expect(await db.fails(`${base}, attributed_via) values ('${accB}', 'dunning', '${caseB}', 'cus_1', 4900, 490, 'verified', now(), 'stripe')`)).toBe(true);
    await db.exec(`${base}, attributed_via) values ('${accB}', 'dunning', '${caseB}', 'cus_1', 4900, 490, 'verified', now(), 'update_link')`);
    // One save per case: a second webhook delivery is a no-op.
    await db.exec(
      `${base}, attributed_via) values ('${accB}', 'dunning', '${caseB}', 'cus_1', 4900, 490, 'verified', now(), 'update_link') on conflict (dunning_case_id) do nothing`,
    );
    expect(await db.count("saves", `dunning_case_id = '${caseB}'`)).toBe(1);

    const session = await db.value<string>(
      `insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id) values ('${accB}', 'cus_2', 'sub_2') returning id`,
    );
    expect(
      await db.fails(`insert into saves (account_id, type, cancel_session_id, stripe_customer_id, attributed_via)
        values ('${accB}', 'cancel', '${session}', 'cus_2', 'update_link')`),
    ).toBe(true);
    await db.exec(`insert into saves (account_id, type, cancel_session_id, stripe_customer_id) values ('${accB}', 'cancel', '${session}', 'cus_2')`);
  });
});

describe("dunning_settings", () => {
  it("defaults to OFF and 0/3/7, and stores schedule arrays as JS number arrays", async () => {
    await db.exec(`insert into dunning_settings (account_id) values ('${accB}')`);
    expect(await db.query(`select enabled, schedule_days from dunning_settings where account_id = '${accB}'`)).toEqual([
      { enabled: false, schedule_days: [0, 3, 7] },
    ]);
    await db.query("update dunning_settings set enabled = true, schedule_days = $2, company_name = 'Acme' where account_id = $1", [accB, [1, 4, 10]]);
    expect(await db.query(`select enabled, schedule_days, company_name from dunning_settings where account_id = '${accB}'`)).toEqual([
      { enabled: true, schedule_days: [1, 4, 10], company_name: "Acme" },
    ]);
  });

  it("rejects schedules that aren't 3 increasing days within 60, and bad templates / reply-to", async () => {
    for (const bad of ["{0,3}", "{3,3,7}", "{0,7,3}", "{-1,3,7}", "{0,3,61}", "{0,3,7,9}"]) {
      expect(await db.fails(`update dunning_settings set schedule_days = '${bad}' where account_id = '${accB}'`)).toBe(true);
    }
    expect(await db.fails(`update dunning_settings set templates = '[]'::jsonb where account_id = '${accB}'`)).toBe(true);
    expect(await db.fails(`update dunning_settings set reply_to_email = 'nope' where account_id = '${accB}'`)).toBe(true);
  });
});

describe("dunning_emails and the once-only send lock", () => {
  it("claims a (case, step) once; repeats see it in flight, then already sent", async () => {
    const first = await claim(caseB, 0);
    expect(first.outcome).toBe("claimed");
    expect((await claim(caseB, 0)).outcome).toBe("in_flight"); // a concurrent cron run
    await db.exec(`update dunning_emails set status = 'sent', sent_at = now() where id = '${first.email_id}'`);
    expect(await claim(caseB, 0)).toEqual({ email_id: first.email_id, outcome: "already_sent" });
    expect(await db.count("dunning_emails", `dunning_case_id = '${caseB}'`)).toBe(1);
  });

  it("retries a failed send up to 3 attempts, then gives up", async () => {
    const first = await claim(caseB, 1);
    expect(first.outcome).toBe("claimed");
    for (let attempt = 2; attempt <= 3; attempt++) {
      await db.exec(`update dunning_emails set status = 'failed' where id = '${first.email_id}'`);
      expect((await claim(caseB, 1)).outcome).toBe("claimed");
    }
    await db.exec(`update dunning_emails set status = 'failed' where id = '${first.email_id}'`);
    expect((await claim(caseB, 1)).outcome).toBe("gave_up");
    expect(await db.value(`select attempts from dunning_emails where id = '${first.email_id}'`)).toBe(3);
  });

  it("reclaims a send abandoned by a crashed run after 10 minutes", async () => {
    const first = await claim(caseB, 2);
    await db.exec(`update dunning_emails set claimed_at = now() - interval '11 minutes' where id = '${first.email_id}'`);
    expect((await claim(caseB, 2)).outcome).toBe("claimed");
  });

  it("counts clicks and treats a click as an open", async () => {
    const id = await db.value<string>(`select id from dunning_emails where dunning_case_id = '${caseB}' and step = 0`);
    expect(await db.value(`select dunning_record_click('${id}') as ok`)).toBe(true);
    expect(await db.value(`select dunning_record_click('${id}') as ok`)).toBe(true);
    expect(await db.value(`select dunning_record_click(gen_random_uuid()) as ok`)).toBe(false);
    const row = (await db.query<{ click_count: number; clicked_at: string | null; opened_at: string | null }>(
      `select click_count, clicked_at, opened_at from dunning_emails where id = '${id}'`,
    ))[0]!;
    expect(row.click_count).toBe(2);
    expect(row.clicked_at).not.toBeNull();
    expect(row.opened_at).not.toBeNull();
  });

  it("rejects a step outside the 3-email sequence", async () => {
    expect(await db.fails(`select * from dunning_claim_email('${accB}', '${caseB}', 3::smallint, 'hard', 'x@y.z', 's')`)).toBe(true);
  });
});
