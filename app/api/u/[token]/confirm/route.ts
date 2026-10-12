import { confirmAfterAction } from "@/lib/dunning/card-update";
import { runCardUpdateAction } from "@/lib/dunning/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** After a 3-D Secure challenge on the payment: check the invoice and record the result. */
export async function POST(request: Request, { params }: { params: { token: string } }) {
  return runCardUpdateAction(request, params.token, (deps) => confirmAfterAction(deps, params.token));
}
