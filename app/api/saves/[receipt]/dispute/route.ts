import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { DisputeError, openDispute } from "@/lib/ledger/disputes";
import { ledgerDeps } from "@/lib/ledger/runtime";
import { getSessionUser } from "@/lib/auth/session";
import { getDb, queryOne } from "@/lib/db";
import { findAccountForUser } from "@/lib/accounts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * "Dispute this save" (a plain form POST from the receipt). The founder is
 * checked with their own session and RLS (they can only see their own
 * saves); the dispute, the fee holds and the auto-rules then run on the
 * server with the service role, because founders can't write the ledger.
 */
export async function POST(request: Request, { params }: { params: { receipt: string } }) {
  const back = (state: string) =>
    NextResponse.redirect(new URL(`/dashboard/saves/${encodeURIComponent(params.receipt)}?dispute=${state}`, request.url), { status: 303 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL(`/login?next=/dashboard/saves/${encodeURIComponent(params.receipt)}`, request.url), { status: 303 });

  // Scoped to the signed-in founder's account: another founder's receipt is "not found".
  let save: { id: string; account_id: string } | null = null;
  try {
    const account = await findAccountForUser(db, user.id);
    save = account
      ? await queryOne<{ id: string; account_id: string }>(db, "select id, account_id from saves where account_id = $1 and receipt_number = $2", [
          account.id,
          params.receipt,
        ])
      : null;
  } catch {
    return back("error");
  }
  if (!save) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  try {
    const result = await openDispute(ledgerDeps(db), {
      accountId: save.account_id,
      receiptSaveId: save.id,
      userId: user.id,
      category: form?.get("category"),
      note: form?.get("note"),
    });
    return back(result.outcome);
  } catch (e) {
    if (e instanceof DisputeError) return back(e.code);
    console.error("[saves/dispute] failed", e);
    return back("error");
  }
}
