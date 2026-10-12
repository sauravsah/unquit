import { NextResponse } from "next/server";
import { emailCaseId, recordEmailClick } from "@/lib/dunning/repo";
import { verifyLinkToken } from "@/lib/dunning/token";
import { publicEnv, serverEnv } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The link inside every dunning email: counts the click, then sends the
 * customer to the card-update page. A click is only counted when the email
 * and the signed link belong to the same case.
 */
export async function GET(request: Request, { params }: { params: { emailId: string } }) {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const target = new URL(`/u/${encodeURIComponent(token)}`, publicEnv.appUrl());

  try {
    const verified = verifyLinkToken(token, serverEnv.dunningLinkSecret(), new Date());
    // Expired links still count as a click; the page explains they've expired.
    const caseId = verified.ok ? verified.payload.caseId : null;
    if (caseId && UUID.test(params.emailId)) {
      const admin = createSupabaseAdminClient();
      if ((await emailCaseId(admin, params.emailId)) === caseId) await recordEmailClick(admin, params.emailId);
    }
  } catch (error) {
    console.warn("[dunning/click] could not record click", error);
  }
  return NextResponse.redirect(target, { status: 302, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
