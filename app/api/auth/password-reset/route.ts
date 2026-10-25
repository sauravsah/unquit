import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { normalizeEmail, signUpErrors, findUserByEmail } from "@/lib/auth/users";
import { createEmailToken, consumeEmailToken } from "@/lib/auth/email-tokens";
import { sendEmail } from "@/lib/email";
import { serverEnv } from "@/lib/env";
import { isSameOrigin } from "@/lib/http";
import { underRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/widget/http";

const headers = { "Cache-Control": "no-store" };
const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin." }, { status: 403, headers });
  const body = ((await request.json().catch(() => null)) ?? {}) as { email?: unknown; token?: unknown; password?: unknown };
  const db = getDb();
  if (typeof body.token === "string") {
    const errors = signUpErrors({ email: "a@b.co", password: body.password });
    if (errors.length) return NextResponse.json({ error: errors.at(-1) }, { status: 400, headers });
    const ok = await consumeEmailToken(db, body.token, "reset_password", body.password as string);
    return ok ? NextResponse.json({ ok: true }, { headers }) : NextResponse.json({ error: "This reset link is invalid or has expired." }, { status: 400, headers });
  }
  const email = normalizeEmail(body.email);
  if (!email) return NextResponse.json({ ok: true }, { headers });
  if (!(await underRateLimit(db, `password-reset:${clientIp(request)}`, 3600, 5, "auth"))) return NextResponse.json({ ok: true }, { headers });
  const user = await findUserByEmail(db, email);
  if (user) {
    try {
      const token = await createEmailToken(db, user.id, "reset_password");
      const url = `${appUrl()}/reset-password?token=${encodeURIComponent(token)}`;
      await sendEmail({ from: `Unquit <${serverEnv.emailFromAddress()}>`, to: user.email, subject: "Reset your Unquit password", text: `Reset your password: ${url}`, html: `<p>Reset your Unquit password: <a href="${url}">Reset password</a></p>` });
    } catch (error) {
      console.error("[password-reset] email failed", error);
    }
  }
  return NextResponse.json({ ok: true }, { headers });
}
