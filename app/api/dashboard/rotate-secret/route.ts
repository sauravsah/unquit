import { NextResponse } from "next/server";
import { isSameOrigin } from "@/lib/http";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Replaces the founder's widget signing secret (e.g. after a leak). */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin" }, { status: 403 });

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url), 303);

  // SECURITY DEFINER function that only touches the caller's own account (migration 0002).
  const { error } = await supabase.rpc("rotate_widget_signing_secret");
  if (error) console.error("[dashboard/rotate-secret] failed", error.message);
  return NextResponse.redirect(new URL(`/dashboard?widget=${error ? "rotate_failed" : "secret_rotated"}`, request.url), 303);
}
