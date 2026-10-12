import { NextResponse } from "next/server";
import { parseFlowConfig, flowToRow } from "@/lib/flows/schema";
import { isSameOrigin } from "@/lib/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Saves the founder's cancel flow. Uses the founder's own (RLS-bound)
 * client, so it can only ever write their own account's row.
 */
export async function PUT(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ errors: ["Please sign in again."] }, { status: 401 });

  const parsed = parseFlowConfig(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ errors: parsed.errors }, { status: 400 });

  const { data: account, error: accountError } = await supabase
    .from("accounts")
    .select("id")
    .eq("owner_user_id", user.id)
    .maybeSingle();
  if (accountError) throw new Error(`Loading account failed: ${accountError.message}`);
  if (!account) return NextResponse.json({ errors: ["Open the dashboard once to create your account."] }, { status: 409 });

  const { error } = await supabase
    .from("flows")
    .upsert({ account_id: account.id, ...flowToRow(parsed.value) }, { onConflict: "account_id" });
  if (error) {
    console.error("[flows] save failed", error.message);
    return NextResponse.json({ errors: ["Saving failed. Please try again."] }, { status: 500 });
  }
  return NextResponse.json({ flow: parsed.value });
}
