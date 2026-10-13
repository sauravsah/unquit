import { LogOut } from "lucide-react";
import Link from "next/link";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function SignoutPage() {
  const user = await getSessionUser();
  return (
    <AuthLayout>
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-white shadow-glow">
        <LogOut className="h-5 w-5" />
      </span>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight text-foreground">Sign out?</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {user ? (
          <>
            You&apos;re signed in as <span className="font-medium text-foreground">{user.email}</span>.
          </>
        ) : (
          "You're not signed in."
        )}
      </p>
      {user ? (
        <form action="/auth/signout" method="post" className="mt-8 space-y-3">
          <Button type="submit" variant="primary" size="lg" className="w-full">
            Sign out
          </Button>
          <Button asChild variant="secondary" size="lg" className="w-full">
            <Link href="/dashboard">Back to dashboard</Link>
          </Button>
        </form>
      ) : (
        <Button asChild variant="primary" size="lg" className="mt-8 w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      )}
    </AuthLayout>
  );
}
