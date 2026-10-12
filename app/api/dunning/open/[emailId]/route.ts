import { recordEmailOpen } from "@/lib/dunning/repo";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A transparent 1×1 GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Open tracking (optional, approximate): many mail apps block or pre-fetch
 * images, so treat opens as a rough signal. Clicks are the reliable one.
 */
export async function GET(_request: Request, { params }: { params: { emailId: string } }) {
  if (UUID.test(params.emailId)) {
    try {
      await recordEmailOpen(createSupabaseAdminClient(), params.emailId, new Date().toISOString());
    } catch (error) {
      console.warn("[dunning/open] could not record open", error);
    }
  }
  return new Response(PIXEL, {
    headers: { "Content-Type": "image/gif", "Content-Length": String(PIXEL.length), "Cache-Control": "no-store, max-age=0" },
  });
}
