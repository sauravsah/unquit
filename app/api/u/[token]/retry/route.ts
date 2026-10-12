import { retryCurrentCard } from "@/lib/dunning/card-update";
import { runCardUpdateAction } from "@/lib/dunning/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Try my card again": pays the open invoice with the card already on file. */
export async function POST(request: Request, { params }: { params: { token: string } }) {
  return runCardUpdateAction(request, params.token, (deps) => retryCurrentCard(deps, params.token));
}
