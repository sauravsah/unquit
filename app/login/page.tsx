import { Wordmark } from "@/components/Wordmark";
import { LoginForm } from "./LoginForm";

const ERRORS: Record<string, string> = {
  link_invalid: "That sign-in link has expired or was already used. Request a new one below.",
  not_configured: "Sign-in isn't configured yet. Add the Supabase keys to the environment variables (see README).",
};

export default function LoginPage({ searchParams }: { searchParams: { next?: string; error?: string } }) {
  const error = searchParams.error ? ERRORS[searchParams.error] ?? "Something went wrong. Please try again." : null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-white px-6">
      <div className="w-full max-w-sm">
        <Wordmark />
        <h1 className="mt-8 text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
        <p className="mt-2 text-sm text-neutral-600">We&apos;ll email you a magic link. No password needed.</p>
        {error ? (
          <p role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <LoginForm next={searchParams.next ?? "/dashboard"} />
      </div>
    </div>
  );
}
