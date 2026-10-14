"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Creates the login (POST /api/signup), then signs straight in. */
export function SignupForm({ next, minPasswordLength }: { next: string; minPasswordLength: number }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setErrors([]);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const body = (await res.json().catch(() => ({}))) as { errors?: string[] };
      if (!res.ok) {
        setErrors(body.errors?.length ? body.errors : ["Couldn't create your account. Please try again."]);
        setPending(false);
        return;
      }
      const signedIn = await signIn("credentials", { email: email.trim(), password, redirect: false, callbackUrl: next });
      if (!signedIn || signedIn.error) {
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setErrors(["Couldn't reach the server. Check your connection and try again."]);
      setPending(false);
    }
  }

  const tooShort = password.length > 0 && password.length < minPasswordLength;

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
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-foreground">Password</span>
        <Input
          type="password"
          name="password"
          required
          minLength={minPasswordLength}
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`At least ${minPasswordLength} characters`}
          className="mt-1.5 h-11"
          aria-invalid={tooShort || undefined}
        />
        <span className={`mt-1.5 block text-xs ${tooShort ? "text-danger" : "text-muted-foreground"}`}>
          {minPasswordLength}+ characters. A passphrase works well.
        </span>
      </label>
      <Button type="submit" variant="primary" size="lg" className="group w-full" loading={pending}>
        Create account
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        By signing up you agree to the{" "}
        <Link href="/terms" target="_blank" className="font-medium text-foreground underline underline-offset-4 hover:text-brand-text">
          Terms
        </Link>{" "}
        and{" "}
        <Link href="/privacy" target="_blank" className="font-medium text-foreground underline underline-offset-4 hover:text-brand-text">
          Privacy Policy
        </Link>
        .
      </p>
      {errors.length ? (
        <motion.ul role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="space-y-1 text-sm text-danger">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </motion.ul>
      ) : null}
    </motion.form>
  );
}
