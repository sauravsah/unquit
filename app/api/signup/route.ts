import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Sign-up moved to Firebase Authentication. Keep this route explicit rather
 * than leaving the old unverified bcrypt flow available to direct callers.
 */
export async function POST() {
  return NextResponse.json(
    { errors: ["Sign-up has moved. Use the public /signup page."] },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
