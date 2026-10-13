import { NextResponse } from "next/server";
import { EmailTakenError, createUser, signUpErrors } from "@/lib/auth/users";
import { getDb } from "@/lib/db";
import { isSameOrigin } from "@/lib/http";
import { underRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/widget/http";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Creates a founder login (email + bcrypt-hashed password). The client signs
 * in with Auth.js right after. Same-origin only, 10 sign-ups / hour / IP.
 *
 * TODO(email): no verification email yet (no email provider); the account is
 * usable immediately and users.email_verified_at stays NULL.
 */
export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ errors: ["Bad origin."] }, { status: 403, headers: NO_STORE });

  const body = ((await request.json().catch(() => null)) ?? {}) as { email?: unknown; password?: unknown };
  const errors = signUpErrors(body);
  if (errors.length) return NextResponse.json({ errors }, { status: 400, headers: NO_STORE });

  const db = getDb();
  if (!(await underRateLimit(db, `signup-ip:${clientIp(request)}`, 3600, 10, "signup"))) {
    return NextResponse.json({ errors: ["Too many sign-ups from this network. Please try again later."] }, { status: 429, headers: NO_STORE });
  }

  try {
    const user = await createUser(db, { email: body.email as string, password: body.password as string });
    return NextResponse.json({ id: user.id, email: user.email }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof EmailTakenError) return NextResponse.json({ errors: [error.message] }, { status: 409, headers: NO_STORE });
    console.error("[signup] failed", error);
    return NextResponse.json({ errors: ["Couldn't create your account. Please try again."] }, { status: 500, headers: NO_STORE });
  }
}
