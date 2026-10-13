import { NextResponse } from "next/server";
import { ledgerToCsv } from "@/lib/ledger/csv";
import { loadLedger, parseLedgerFilters, toCsvRows } from "@/lib/ledger/dashboard";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { findAccountForUser } from "@/lib/accounts";

export const dynamic = "force-dynamic";

/**
 * The saves ledger as a CSV download, with the same filters as the table
 * (?type=&status=&month=). Read with the founder's RLS-bound client, so it
 * can only ever contain their own saves.
 */
export async function GET(request: Request) {
  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  let account;
  try {
    account = await findAccountForUser(db, user.id);
  } catch {
    return NextResponse.json({ error: "Loading account failed" }, { status: 500 });
  }
  if (!account) return NextResponse.json({ error: "No account yet" }, { status: 404 });

  const filters = parseLedgerFilters(new URL(request.url).searchParams);
  const items = await loadLedger(db, account.id, filters, 10_000);
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
