/**
 * Runs 0001 + 0002 + 0003 against a real (in-memory, WASM) Postgres, like
 * the earlier migration tests, and checks week 3's rules: RLS on the new
 * tables, the attribution constraints, and the once-only email lock the
 * cron relies on.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const sql = (name: string) => readFileSync(fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)), "utf8");

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";

let db: PGlite;
let accA = "";
let accB = "";
let caseB = "";
let legacyCase = "";

const asUser = async (userId: string) => {
  await db.exec("reset role");
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false);`);
};
const asAnon = async () => {
  await db.exec("reset role");
  await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false);`);
};
const asService = () => db.exec("reset role");
const fails = async (statement: string) => {
  try {
    await db.exec(statement);
    return false;
  } catch {
    return true;
  }
};
const rows = async <T>(q: string) => (await db.query<T>(q)).rows;
const count = async (table: string) => (await rows<{ c: number }>(`select count(*)::int as c from ${table}`))[0]!.c;
const claim = async (caseId: string, step: number) =>
  (
    await rows<{ email_id: string; outcome: string }>(
      `select * from dunning_claim_email('${accB}', '${caseId}', ${step}::smallint, 'hard', 'c@example.com', 'Card update needed')`,
    )
  )[0]!;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
    alter default privileges in schema public grant all on sequences to anon, authenticated;
    alter default privileges in schema public grant all on functions to anon, authenticated;
  `);
  await db.exec(sql("0001_init.sql"));
  await db.exec(sql("0002_cancel_flow.sql"));
  await db.exec(`insert into auth.users values ('${A}', 'a@example.com'), ('${B}', 'b@example.com');`);
  accA = (await rows<{ id: string }>(`insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status)
     values ('${A}', 'A org', 'acct_A', 'connected') returning id`))[0]!.id;
  accB = (await rows<{ id: string }>(`insert into accounts (owner_user_id, name, stripe_account_id, stripe_connection_status)
     values ('${B}', 'B org', 'acct_B', 'connected') returning id`))[0]!.id;
  // A week-1 case that exists BEFORE 0003 runs, recovered 'external'.
  legacyCase = (await rows<{ id: string }>(`insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents, status, recovered_via)
     values ('${accB}', 'in_old', 'cus_old', 1000, 'recovered', 'external') returning id`))[0]!.id;
  await db.exec(sql("0003_dunning.sql"));
  caseB = (await rows<{ id: string }>(`insert into dunning_cases (account_id, stripe_invoice_id, stripe_customer_id, amount_due_cents, decline_code, decline_category, customer_email)
     values ('${accB}', 'in_1', 'cus_1', 4900, 'expired_card', 'hard', 'c@example.com') returning id`))[0]!.id;
}, 60_000);

describe("dunning_cases after 0003", () => {
  it("keeps week-1 rows and gives every case its own link nonce", async () => {
    const all = await rows<{ id: string; link_nonce: string; sequence_step: number; recovered_via: string | null }>(
      `select id, link_nonce, sequence_step, recovered_via from dunning_cases order by created_at`,
    );
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === legacyCase)!.recovered_via).toBe("external");
    expect(all[0]!.link_nonce).not.toBe(all[1]!.link_nonce);
    expect(all.every((r) => r.sequence_step === 0)).toBe(true);
  });

  it("checks decline category, attribution names and the pending-attribution pair", async () => {
    expect(await fails(`update dunning_cases set decline_category = 'weird' where id = '${caseB}'`)).toBe(true);
    expect(await fails(`update dunning_cases set recovered_via = 'unquit_link' where id = '${caseB}'`)).toBe(true);
    expect(await fails(`update dunning_cases set sequence_step = 4 where id = '${caseB}'`)).toBe(true);
    expect(await fails(`update dunning_cases set pending_attribution = 'update_link' where id = '${caseB}'`)).toBe(true);
    await db.exec(`update dunning_cases set pending_attribution = 'update_link', pending_attribution_at = now() where id = '${caseB}'`);
    await db.exec(`update dunning_cases set pending_attribution = null, pending_attribution_at = null where id = '${caseB}'`);
  });

  it("stays read-only and account-scoped for founders", async () => {
    await asUser(A);
    expect(await count("dunning_cases")).toBe(0);
    expect(await fails(`update dunning_cases set next_email_at = now()`)).toBe(false); // RLS: silently 0 rows
    await asUser(B);
    expect(await count("dunning_cases")).toBe(2);
    expect(await fails(`update dunning_cases set status = 'closed' where id = '${caseB}'`)).toBe(false);
    await asService();
    expect((await rows<{ status: string }>(`select status from dunning_cases where id = '${caseB}'`))[0]!.status).toBe("open");
  });
});

describe("saves.attributed_via", () => {
  it("requires an attribution on dunning saves and forbids it on cancel saves", async () => {
    const base = `insert into saves (account_id, type, dunning_case_id, stripe_customer_id, recovered_amount_cents, fee_cents, status, verified_at`;
    expect(await fails(`${base}) values ('${accB}', 'dunning', '${caseB}', 'cus_1', 4900, 490, 'verified', now())`)).toBe(true);
    expect(
      await fails(`${base}, attributed_via) values ('${accB}', 'dunning', '${caseB}', 'cus_1', 4900, 490, 'verified', now(), 'stripe')`),
    ).toBe(true);
    await db.exec(`${base}, attributed_via) values ('${accB}', 'dunning', '${caseB}', 'cus_1', 4900, 490, 'verified', now(), 'update_link')`);
    // One save per case: a second webhook delivery is a no-op.
    await db.exec(
      `${base}, attributed_via) values ('${accB}', 'dunning', '${caseB}', 'cus_1', 4900, 490, 'verified', now(), 'update_link') on conflict (dunning_case_id) do nothing`,
    );
    expect((await rows<{ c: number }>(`select count(*)::int as c from saves where dunning_case_id = '${caseB}'`))[0]!.c).toBe(1);

    const session = (
      await rows<{ id: string }>(`insert into cancel_sessions (account_id, stripe_customer_id, stripe_subscription_id) values ('${accB}', 'cus_2', 'sub_2') returning id`)
    )[0]!.id;
    expect(
      await fails(`insert into saves (account_id, type, cancel_session_id, stripe_customer_id, attributed_via)
        values ('${accB}', 'cancel', '${session}', 'cus_2', 'update_link')`),
    ).toBe(true);
    await db.exec(`insert into saves (account_id, type, cancel_session_id, stripe_customer_id) values ('${accB}', 'cancel', '${session}', 'cus_2')`);
  });
});

describe("dunning_settings (RLS)", () => {
  it("lets a founder create, read and update their own settings, defaulting to OFF and 0/3/7", async () => {
    await asUser(A);
    await db.exec(`insert into dunning_settings (account_id) values ('${accA}')`);
    expect(await rows(`select enabled, schedule_days from dunning_settings`)).toEqual([{ enabled: false, schedule_days: [0, 3, 7] }]);
    await db.exec(`update dunning_settings set enabled = true, schedule_days = '{1,4,10}', company_name = 'Acme' where account_id = '${accA}'`);
    expect(await rows(`select enabled, schedule_days, company_name from dunning_settings`)).toEqual([
      { enabled: true, schedule_days: [1, 4, 10], company_name: "Acme" },
    ]);
    await asService();
  });

  it("blocks another founder's settings and anonymous access", async () => {
    await asService();
    await db.exec(`insert into dunning_settings (account_id, company_name) values ('${accB}', 'B Co')`);
    await asUser(A);
    expect(await count("dunning_settings")).toBe(1);
    expect(await fails(`insert into dunning_settings (account_id) values ('${accB}')`)).toBe(true);
    await db.exec(`update dunning_settings set enabled = true where account_id = '${accB}'`); // 0 rows
    expect(await fails(`update dunning_settings set account_id = '${accB}' where account_id = '${accA}'`)).toBe(true);
    await asAnon();
    expect(await count("dunning_settings")).toBe(0);
    expect(await fails(`insert into dunning_settings (account_id) values ('${accA}')`)).toBe(true);
    await asService();
    expect((await rows<{ enabled: boolean }>(`select enabled from dunning_settings where account_id = '${accB}'`))[0]!.enabled).toBe(false);
  });

  it("rejects schedules that aren't 3 increasing days within 60", async () => {
    await asUser(A);
    for (const bad of ["{0,3}", "{3,3,7}", "{0,7,3}", "{-1,3,7}", "{0,3,61}", "{0,3,7,9}"]) {
      expect(await fails(`update dunning_settings set schedule_days = '${bad}' where account_id = '${accA}'`)).toBe(true);
    }
    expect(await fails(`update dunning_settings set templates = '[]'::jsonb where account_id = '${accA}'`)).toBe(true);
    expect(await fails(`update dunning_settings set reply_to_email = 'nope' where account_id = '${accA}'`)).toBe(true);
    await asService();
  });
});

describe("dunning_emails and the once-only send lock", () => {
  it("claims a (case, step) once; repeats see it in flight, then already sent", async () => {
    const first = await claim(caseB, 0);
    expect(first.outcome).toBe("claimed");
    expect((await claim(caseB, 0)).outcome).toBe("in_flight"); // a concurrent cron run
    await db.exec(`update dunning_emails set status = 'sent', sent_at = now() where id = '${first.email_id}'`);
    expect(await claim(caseB, 0)).toEqual({ email_id: first.email_id, outcome: "already_sent" });
    expect((await rows<{ c: number }>(`select count(*)::int as c from dunning_emails where dunning_case_id = '${caseB}'`))[0]!.c).toBe(1);
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
    expect((await rows<{ attempts: number }>(`select attempts from dunning_emails where id = '${first.email_id}'`))[0]!.attempts).toBe(3);
  });

  it("reclaims a send abandoned by a crashed run after 10 minutes", async () => {
    const first = await claim(caseB, 2);
    await db.exec(`update dunning_emails set claimed_at = now() - interval '11 minutes' where id = '${first.email_id}'`);
    expect((await claim(caseB, 2)).outcome).toBe("claimed");
  });

  it("counts clicks and treats a click as an open", async () => {
    const id = (await rows<{ id: string }>(`select id from dunning_emails where dunning_case_id = '${caseB}' and step = 0`))[0]!.id;
    expect((await rows<{ ok: boolean }>(`select dunning_record_click('${id}') as ok`))[0]!.ok).toBe(true);
    expect((await rows<{ ok: boolean }>(`select dunning_record_click('${id}') as ok`))[0]!.ok).toBe(true);
    expect((await rows<{ ok: boolean }>(`select dunning_record_click(gen_random_uuid()) as ok`))[0]!.ok).toBe(false);
    const row = (await rows<{ click_count: number; clicked_at: string | null; opened_at: string | null }>(
      `select click_count, clicked_at, opened_at from dunning_emails where id = '${id}'`,
    ))[0]!;
    expect(row.click_count).toBe(2);
    expect(row.clicked_at).not.toBeNull();
    expect(row.opened_at).not.toBeNull();
  });

  it("is read-only and account-scoped for founders; the lock functions are service-role only", async () => {
    await asUser(A);
    expect(await count("dunning_emails")).toBe(0);
    expect(await fails(`select * from dunning_claim_email('${accA}', '${caseB}', 0::smallint, 'hard', 'x@y.z', 's')`)).toBe(true);
    expect(await fails(`select dunning_record_click(gen_random_uuid())`)).toBe(true);
    await asUser(B);
    expect(await count("dunning_emails")).toBe(3);
    expect(
      await fails(`insert into dunning_emails (account_id, dunning_case_id, step, category, to_email, subject)
        values ('${accB}', '${caseB}', 0, 'hard', 'x@y.z', 'forged')`),
    ).toBe(true);
    await db.exec(`update dunning_emails set status = 'sent'`); // no update policy: 0 rows
    await asAnon();
    expect(await count("dunning_emails")).toBe(0);
    await asService();
    expect((await rows<{ c: number }>(`select count(*)::int as c from dunning_emails where status = 'sending'`))[0]!.c).toBe(1);
  });

  it("rejects a step outside the 3-email sequence", async () => {
    expect(await fails(`select * from dunning_claim_email('${accB}', '${caseB}', 3::smallint, 'hard', 'x@y.z', 's')`)).toBe(true);
  });
});
