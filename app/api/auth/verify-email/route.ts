import { NextResponse } from "next/server";
import { consumeEmailToken } from "@/lib/auth/email-tokens";
import { getDb } from "@/lib/db";
import { isSameOrigin } from "@/lib/http";

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Bad origin." }, { status: 403 });
  const body = ((await request.json().catch(() => null)) ?? {}) as { token?: unknown };
  const ok = typeof body.token === "string" && (await consumeEmailToken(getDb(), body.token, "verify_email"));
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "This verification link is invalid or has expired." }, { status: 400 });
}
