import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Run on pages, skip static assets, the Stripe webhook (it has no session
  // and must receive the raw, untouched body) and the public widget script +
  // API (called from founders' sites, never with a founder session).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/stripe/webhook|api/widget/|widget\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
