import { runWidgetEndpoint, widgetPreflight } from "@/lib/widget/http";
import { startSession } from "@/lib/widget/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return widgetPreflight();
}

/**
 * Opens a cancel session. Checks the subscription belongs to the signed
 * customer on the founder's connected account, then returns the flow config
 * (reasons + the offer each reason earns for this subscription).
 */
export async function POST(request: Request) {
  return runWidgetEndpoint(request, "session", ({ ctx, deps }) => startSession(deps, ctx));
}
