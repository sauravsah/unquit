"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { AuthLayout, AuthAlert, AuthNotice } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function ResetPasswordPage() {
  const token = useSearchParams().get("token") ?? ""; const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [done, setDone] = useState(false); const [pending, setPending] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); setPending(true); const r = await fetch("/api/auth/password-reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) }); const b = await r.json(); setError(r.ok ? "" : b.error ?? "Couldn’t reset password."); setDone(r.ok); setPending(false); }
  return <AuthLayout><h1 className="text-3xl font-semibold tracking-tight">Choose a new password</h1>{done ? <AuthNotice>Password updated. <Link href="/login" className="underline">Sign in</Link></AuthNotice> : <form onSubmit={submit} className="mt-8 space-y-4"><Input type="password" required minLength={8} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" /><Button type="submit" className="w-full" loading={pending}>Update password</Button>{error && <AuthAlert>{error}</AuthAlert>}</form>}</AuthLayout>;
}
