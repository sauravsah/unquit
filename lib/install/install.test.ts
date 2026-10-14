/** Shareable developer setup links (/install/<token>) and the public page's loader. */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/core";
import { addFounder, createTestDb, type TestDb } from "@/lib/db/testing/pglite";
import { signCustomer } from "@/lib/widget/hmac";
import { SECRET_PLACEHOLDER, buildSnippets, developerMessage, scriptTag } from "./snippets";
import { INSTALL_TOKEN_PATTERN, installLinkUrl, isInstallToken } from "./token";

vi.mock("server-only", () => ({}));
const { getInstallLinkToken, loadPublicInstallView, rotateInstallLinkToken } = await import("./repo");

let db: TestDb;
let a: { accountId: string; token: string; pk: string; secret: string };
let b: { accountId: string; token: string; pk: string; secret: string };

async function founder() {
  const { accountId } = await addFounder(db, { stripe: null });
  const row = (
    await db.query<{ install_link_token: string; widget_publishable_key: string; widget_signing_secret: string }>(
      "select install_link_token, widget_publishable_key, widget_signing_secret from accounts where id = $1",
      [accountId],
    )
  )[0]!;
  return { accountId, token: row.install_link_token, pk: row.widget_publishable_key, secret: row.widget_signing_secret };
}

beforeAll(async () => {
  db = await createTestDb();
  a = await founder();
  b = await founder();
}, 60_000);

/** Flips one hex character, keeping the token well-formed. */
function tamper(token: string, at = token.length - 1): string {
  const c = token[at] === "0" ? "1" : "0";
  return token.slice(0, at) + c + token.slice(at + 1);
}

describe("install link token", () => {
  it("is random per account, well-formed and not the account id", async () => {
    expect(a.token).toMatch(INSTALL_TOKEN_PATTERN);
    expect(b.token).toMatch(INSTALL_TOKEN_PATTERN);
    expect(a.token).not.toBe(b.token);
    expect(a.token).not.toContain(a.accountId.replace(/-/g, ""));
    expect(a.token).not.toContain(a.accountId);
    expect(await getInstallLinkToken(db, a.accountId)).toBe(a.token);
  });

  it("a valid token loads that founder's publishable key", async () => {
    expect(await loadPublicInstallView(db, a.token)).toEqual({ publishableKey: a.pk });
    expect(await loadPublicInstallView(db, b.token)).toEqual({ publishableKey: b.pk });
  });

  it("a tampered token loads nothing", async () => {
    for (const bad of [tamper(a.token), tamper(a.token, 10), a.token.toUpperCase(), `${a.token}0`, a.token.slice(0, -1)]) {
      expect(await loadPublicInstallView(db, bad)).toBeNull();
    }
  });

  it("never resolves to the wrong account, nor from the account id, key or secret", async () => {
    expect((await loadPublicInstallView(db, a.token))?.publishableKey).not.toBe(b.pk);
    for (const guess of [a.accountId, a.pk, a.secret, `uqi_${a.accountId.replace(/-/g, "")}`, "", null, undefined, 42, { token: a.token }]) {
      expect(await loadPublicInstallView(db, guess)).toBeNull();
    }
  });

  it("rejects malformed tokens before touching the database", async () => {
    const spy = { query: vi.fn(async () => []) };
    const fake = spy as unknown as Db;
    expect(await loadPublicInstallView(fake, "'; drop table accounts; --")).toBeNull();
    expect(await loadPublicInstallView(fake, "../../etc/passwd")).toBeNull();
    expect(spy.query).not.toHaveBeenCalled();
    expect(isInstallToken(a.token)).toBe(true);
    expect(isInstallToken(a.accountId)).toBe(false);
  });

  it("rotating kills the old link for that founder only", async () => {
    const before = a.token;
    expect(await rotateInstallLinkToken(db, a.accountId)).toBe(true);
    const after = await getInstallLinkToken(db, a.accountId);
    expect(after).not.toBe(before);
    expect(after).toMatch(INSTALL_TOKEN_PATTERN);
    expect(await loadPublicInstallView(db, before)).toBeNull();
    expect(await loadPublicInstallView(db, after)).toEqual({ publishableKey: a.pk });
    // The other founder's link and both founders' widget keys are untouched.
    expect(await loadPublicInstallView(db, b.token)).toEqual({ publishableKey: b.pk });
    expect(await db.value("select widget_signing_secret from accounts where id = $1", [a.accountId])).toBe(a.secret);
    a = { ...a, token: after };
  });

  it("builds the public URL", () => {
    expect(installLinkUrl("https://unquit.vercel.app/", a.token)).toBe(`https://unquit.vercel.app/install/${a.token}`);
  });
});

describe("public install page data", () => {
  it("the loader returns only the publishable key: no secret, no account data", async () => {
    const view = await loadPublicInstallView(db, a.token);
    expect(Object.keys(view ?? {})).toEqual(["publishableKey"]);
    const json = JSON.stringify(view);
    expect(json).not.toContain(a.secret);
    expect(json).not.toContain("uqsk_");
    expect(json).not.toContain(a.accountId);
    expect(json).not.toContain("@example.com");
  });

  it("only selects the publishable key from the database", async () => {
    const queries: string[] = [];
    const spy = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return [{ widget_publishable_key: "pk_x" }];
      }),
    };
    await loadPublicInstallView(spy as unknown as Db, a.token);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^select widget_publishable_key from accounts where install_link_token = \$1$/);
    expect(queries[0]).not.toMatch(/secret|\*/);
  });

  it("the page's snippets carry the key and app URL, and only a placeholder for the secret", () => {
    const snippets = buildSnippets({ appUrl: "https://unquit.vercel.app", publishableKey: a.pk });
    const all = Object.values(snippets).map((s) => s.code).join("\n") + developerMessage(installLinkUrl("https://unquit.vercel.app", a.token));
    expect(all).not.toContain(a.secret);
    expect(all).not.toMatch(/uqsk_[0-9a-f]/);
    expect(all).toContain(SECRET_PLACEHOLDER);
    expect(snippets.script.code).toBe(`<script src="https://unquit.vercel.app/widget.js" data-unquit-key="${a.pk}" defer></script>`);
    expect(scriptTag({ appUrl: "https://x.test//", publishableKey: "pk_1" })).toContain('src="https://x.test/widget.js"');
  });

  it("the server snippets sign exactly what the widget API verifies", () => {
    const { node, python, frontend } = buildSnippets({ appUrl: "https://x.test", publishableKey: "pk_1" });
    // Same message format as lib/widget/hmac.ts (customerId:subscriptionId, hex digest).
    expect(node.code).toContain('createHmac("sha256", UNQUIT_SIGNING_SECRET)');
    expect(node.code).toContain(".update(`${stripeCustomerId}:${stripeSubscriptionId}`)");
    expect(node.code).toContain('.digest("hex")');
    expect(python.code).toContain('f"{customer_id}:{subscription_id}".encode()');
    expect(python.code).toContain("hashlib.sha256).hexdigest()");
    expect(frontend.code).toContain("Unquit.open(auth)");
    expect(node.code).toContain("res.json({ customerId: stripeCustomerId, subscriptionId: stripeSubscriptionId, hmac })");
    // And that format really is what the server checks.
    expect(signCustomer("uqsk_test", "cus_1", "sub_1")).toMatch(/^[0-9a-f]{64}$/);
  });
});
