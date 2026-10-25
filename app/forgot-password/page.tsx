"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AuthLayout, AuthNotice } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState(""); const [sent, setSent] = useState(false); const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); setPending(true); await fetch("/api/auth/password-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) }); setSent(true); setPending(false); }
  return <AuthLayout><h1 className="text-3xl font-semibold tracking-tight">Reset password</h1><p className="mt-2 text-sm text-muted-foreground">We&apos;ll email a one-hour reset link if an account exists.</p>{sent ? <AuthNotice>Check your inbox for a reset link.</AuthNotice> : <form onSubmit={submit} className="mt-8 space-y-4"><Input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /><Button type="submit" className="w-full" loading={pending}>Email reset link</Button></form>}<p className="mt-6 text-sm text-muted-foreground"><Link href="/login" className="underline">Back to sign in</Link></p></AuthLayout>;
}
