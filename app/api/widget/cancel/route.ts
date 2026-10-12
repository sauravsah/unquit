import { runWidgetEndpoint, widgetPreflight } from "@/lib/widget/http";
import { cancelSubscription } from "@/lib/widget/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function OPTIONS() {
  return widgetPreflight();
}

/**
 * Records the reason and cancels: at period end (default) or immediately,
 * per the founder's flow setting. Idempotent per session.
 */
export async function POST(request: Request) {
  return runWidgetEndpoint(request, "cancel", ({ ctx, deps, body }) =>
    cancelSubscription(deps, ctx, { sessionId: body.sessionId, reasonId: body.reasonId, reasonDetail: body.reasonDetail }),
  );
}
