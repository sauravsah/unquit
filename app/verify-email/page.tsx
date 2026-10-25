"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AuthLayout, AuthAlert, AuthNotice } from "@/components/auth/AuthLayout";

function VerifyEmailForm() {
  const token = useSearchParams().get("token") ?? ""; const [state, setState] = useState<"loading" | "done" | "error">("loading");
  useEffect(() => { fetch("/api/auth/verify-email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) }).then((r) => setState(r.ok ? "done" : "error")).catch(() => setState("error")); }, [token]);
  return <AuthLayout><h1 className="text-3xl font-semibold tracking-tight">Verify your email</h1>{state === "loading" ? <p className="mt-6 text-sm text-muted-foreground">Verifying…</p> : state === "done" ? <AuthNotice>Email verified. <Link href="/dashboard" className="underline">Go to dashboard</Link></AuthNotice> : <AuthAlert>This verification link is invalid or has expired. Sign in to request another link.</AuthAlert>}</AuthLayout>;
}

export default function VerifyEmailPage() {
  return <Suspense fallback={<AuthLayout><p className="text-sm text-muted-foreground">Loading…</p></AuthLayout>}><VerifyEmailForm /></Suspense>;
}
