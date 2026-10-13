import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthAlert, AuthLayout, AuthNotice } from "@/components/auth/AuthLayout";
import { safeNextPath } from "@/lib/accounts";
import { getSessionUser } from "@/lib/auth/session";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  not_configured: "Sign-in isn't configured yet. Set AUTH_SECRET and DATABASE_URL in the environment variables (see README).",
  CredentialsSignin: "That email and password don't match. Try again.",
  SessionRequired: "Please sign in to continue.",
  rate_limited: "Too many sign-in attempts. Please wait a few minutes and try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: { next?: string; error?: string; signed_out?: string } }) {
  const next = safeNextPath(searchParams.next);
  if (await getSessionUser()) redirect(next);
  const error = searchParams.error ? ERRORS[searchParams.error] ?? "Something went wrong. Please try again." : null;

  return (
    <AuthLayout>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Welcome back</h1>
      <p className="mt-2 text-sm text-muted-foreground">Sign in with your email and password.</p>
      {error ? <AuthAlert>{error}</AuthAlert> : searchParams.signed_out ? <AuthNotice>You&apos;re signed out. See you soon.</AuthNotice> : null}
      <LoginForm next={next} />
      <p className="mt-6 text-sm text-muted-foreground">
        New to unquit?{" "}
        <Link href={`/signup${next !== "/dashboard" ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-brand-text underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
      <p className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-brand-text" /> Forgot your password? Email support for now: self-serve resets are coming soon.
      </p>
    </AuthLayout>
  );
}
