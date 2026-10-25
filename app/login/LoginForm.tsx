"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { firebaseSignIn, sendVerification } from "@/lib/firebase-client";

const MESSAGES: Record<string, string> = {
  CredentialsSignin: "That email and password don't match. Try again.",
  rate_limited: "Too many sign-in attempts. Please wait a few minutes and try again.",
};

/** Email + password sign-in through Firebase Auth. */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const account = await firebaseSignIn(email.trim(), password);
      const session = await fetch("/api/auth/firebase-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ idToken: account.idToken }) });
      if (!session.ok) {
        const body = await session.json().catch(() => ({})) as { error?: string };
        if (session.status === 403) {
          await sendVerification(account.idToken);
          setError("Verify your email first. We sent you a fresh verification link.");
        } else setError(body.error ?? "Couldn't sign you in. Please try again.");
        setPending(false);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't reach the server. Check your connection and try again.";
      setError(message === "EMAIL_NOT_FOUND" || message === "INVALID_PASSWORD" || message === "INVALID_LOGIN_CREDENTIALS" ? MESSAGES.CredentialsSignin : message);
      setPending(false);
    }
  }

  return (
    <motion.form onSubmit={onSubmit} initial={false} className="mt-8 space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-foreground">Work email</span>
        <Input
          type="email"
          name="email"
          required
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          className="mt-1.5 h-11"
          aria-invalid={error ? true : undefined}
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-foreground">Password</span>
        <Input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="mt-1.5 h-11"
          aria-invalid={error ? true : undefined}
        />
      </label>
      <Button type="submit" variant="primary" size="lg" className="group w-full" loading={pending}>
        Sign in
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Button>
      {error ? (
        <motion.p role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-sm text-danger">
          {error}
        </motion.p>
      ) : null}
    </motion.form>
  );
}
