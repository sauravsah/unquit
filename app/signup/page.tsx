import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { safeNextPath } from "@/lib/accounts";
import { getSessionUser } from "@/lib/auth/session";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/users";
import { SignupForm } from "./SignupForm";

export const dynamic = "force-dynamic";

export default async function SignupPage({ searchParams }: { searchParams: { next?: string } }) {
  const next = safeNextPath(searchParams.next);
  if (await getSessionUser()) redirect(next);

  return (
    <AuthLayout>
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">Create your account</h1>
      <p className="mt-2 text-sm text-muted-foreground">$0 to start. You only pay for customers we keep.</p>
      <SignupForm next={next} minPasswordLength={MIN_PASSWORD_LENGTH} />
      <p className="mt-6 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href={`/login${next !== "/dashboard" ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-medium text-brand-text underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
      <p className="mt-8 flex items-center gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-brand-text" /> No card needed. Connect Stripe after you sign up.
      </p>
    </AuthLayout>
  );
}
