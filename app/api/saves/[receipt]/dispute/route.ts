import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { DisputeError, openDispute } from "@/lib/ledger/disputes";
import { ledgerDeps } from "@/lib/ledger/runtime";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/login?next=/dashboard/saves/${encodeURIComponent(params.receipt)}`, request.url), { status: 303 });

  // RLS: this only finds the save if it belongs to the signed-in founder.
  const { data: save, error } = await supabase.from("saves").select("id, account_id").eq("receipt_number", params.receipt).maybeSingle();
  if (error) return back("error");
  if (!save) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const form = await request.formData().catch(() => null);
  try {
    const result = await openDispute(ledgerDeps(createSupabaseAdminClient()), {
      accountId: save.account_id as string,
      receiptSaveId: save.id as string,
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
