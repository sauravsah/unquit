import { NextResponse } from "next/server";
import { parseDunningSettings, settingsToRow } from "@/lib/dunning/settings";
import { isSameOrigin } from "@/lib/http";
import { getSessionUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { findAccountForUser } from "@/lib/accounts";
import { saveDunningSettings } from "@/lib/dunning/repo";

export const dynamic = "force-dynamic";

/**
 * Saves the founder's dunning settings and email templates. Uses the
 * founder's own (RLS-bound) client, so it can only ever write their own row.
 */
export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const db = getDb();
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ errors: ["Please sign in again."] }, { status: 401 });

  const parsed = parseDunningSettings(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ errors: parsed.errors }, { status: 400 });

  const account = await findAccountForUser(db, user.id);
  if (!account) return NextResponse.json({ errors: ["Open the dashboard once to create your account."] }, { status: 409 });

  try {
    await saveDunningSettings(db, account.id, settingsToRow(parsed.value));
  } catch (error) {
    console.error("[dunning/settings] save failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ errors: ["Saving failed. Please try again."] }, { status: 500 });
  }
  return NextResponse.json({ settings: parsed.value });
}
