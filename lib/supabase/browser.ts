"use client";

import { createBrowserClient } from "@supabase/ssr";

/** Supabase client for Client Components (the sign-in form). */
export function createSupabaseBrowserClient() {
  // Referenced literally so Next.js inlines them at build time.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }
  return createBrowserClient(url, anonKey);
}
