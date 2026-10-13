import { NextResponse } from "next/server";
import { parseFlowConfig, flowToRow } from "@/lib/flows/schema";
import { isSameOrigin } from "@/lib/http";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { findAccountForUser } from "@/lib/accounts";
import { saveFlowRow } from "@/lib/flows/repo";

export const dynamic = "force-dynamic";

/**
 * Saves the founder's cancel flow. Uses the founder's own (RLS-bound)
 * client, so it can only ever write their own account's row.
 */
export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ errors: ["Please sign in again."] }, { status: 401 });

  const parsed = parseFlowConfig(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ errors: parsed.errors }, { status: 400 });

  const account = await findAccountForUser(db, user.id);
  if (!account) return NextResponse.json({ errors: ["Open the dashboard once to create your account."] }, { status: 409 });

  try {
    await saveFlowRow(db, account.id, flowToRow(parsed.value));
  } catch (error) {
    console.error("[flows] save failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ errors: ["Saving failed. Please try again."] }, { status: 500 });
  }
  return NextResponse.json({ flow: parsed.value });
}
