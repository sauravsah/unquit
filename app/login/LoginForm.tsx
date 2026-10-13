"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MESSAGES: Record<string, string> = {
  CredentialsSignin: "That email and password don't match. Try again.",
  rate_limited: "Too many sign-in attempts. Please wait a few minutes and try again.",
};

/** Email + password sign-in through Auth.js (Credentials provider). */
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
      const res = await signIn("credentials", { email: email.trim(), password, redirect: false, callbackUrl: next });
      if (!res || res.error) {
        setError(MESSAGES[res?.error ?? ""] ?? "Couldn't sign you in. Please try again.");
        setPending(false);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
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
