import { NextResponse } from "next/server";
import { ledgerToCsv } from "@/lib/ledger/csv";
import { loadLedger, parseLedgerFilters, toCsvRows } from "@/lib/ledger/dashboard";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * The saves ledger as a CSV download, with the same filters as the table
 * (?type=&status=&month=). Read with the founder's RLS-bound client, so it
 * can only ever contain their own saves.
 */
export async function GET(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data: account, error } = await supabase.from("accounts").select("id").eq("owner_user_id", user.id).maybeSingle();
  if (error) return NextResponse.json({ error: "Loading account failed" }, { status: 500 });
  if (!account) return NextResponse.json({ error: "No account yet" }, { status: 404 });

  const filters = parseLedgerFilters(new URL(request.url).searchParams);
  const items = await loadLedger(supabase, account.id as string, filters, 10_000);
  const csv = ledgerToCsv(toCsvRows(items));
  const suffix = [filters.type, filters.status, filters.month].filter(Boolean).join("-");
  const filename = `unquit-ledger${suffix ? `-${suffix}` : ""}.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
