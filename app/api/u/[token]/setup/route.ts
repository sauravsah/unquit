import { startCardUpdate } from "@/lib/dunning/card-update";
import { runCardUpdateAction } from "@/lib/dunning/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Creates the SetupIntent (on the founder's Stripe account) that Stripe Elements confirms. */
export async function POST(request: Request, { params }: { params: { token: string } }) {
  return runCardUpdateAction(request, params.token, (deps) => startCardUpdate(deps, params.token));
}
