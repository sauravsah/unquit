import { runWidgetEndpoint, widgetPreflight } from "@/lib/widget/http";
import { acceptOffer } from "@/lib/widget/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return widgetPreflight();
}

/**
 * Applies the reason's offer in Stripe (on the connected account), records
 * the accepted session and a PENDING save. Idempotent per session.
 */
export async function POST(request: Request) {
  return runWidgetEndpoint(request, "accept", ({ ctx, deps, body }) =>
    acceptOffer(deps, ctx, { sessionId: body.sessionId, reasonId: body.reasonId, reasonDetail: body.reasonDetail }),
  );
}
