"use client";

import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { firebaseSignUp, sendVerification } from "@/lib/firebase-client";

/** Firebase owns passwords and delivers the verification email. */
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
      const account = await firebaseSignUp(email.trim(), password);
      await sendVerification(account.idToken);
      router.replace(`/login?verify=sent&next=${encodeURIComponent(next)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't create your account. Please try again.";
      setErrors([message === "EMAIL_EXISTS" ? "An account with that email already exists. Sign in instead." : message]);
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
      <p className="text-center text-xs text-muted-foreground">We’ll send a verification link before your account can be used.</p>
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
