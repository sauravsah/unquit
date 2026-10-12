import { payWithNewCard } from "@/lib/dunning/card-update";
import { runCardUpdateAction } from "@/lib/dunning/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** After Elements confirmed the card: make it the default and pay the open invoice now. */
export async function POST(request: Request, { params }: { params: { token: string } }) {
  return runCardUpdateAction(request, params.token, (deps, body) => payWithNewCard(deps, params.token, body.setupIntentId));
}
