import type Stripe from "stripe";

/**
 * An in-memory stand-in for the `stripe` client: `client.<resource>.<method>(...)`
 * records the call and answers from `handlers["resource.method"]`. An
 * unexpected call throws, so a test fails loudly if code calls Stripe in a way
 * it shouldn't.
 */
export type FakeCall = { method: string; args: unknown[] };
export type FakeHandlers = Record<string, (...args: unknown[]) => unknown>;

export function fakeStripe(handlers: FakeHandlers = {}, name = "fake") {
  const calls: FakeCall[] = [];
  const resources = new Map<string, unknown>();
  const client = new Proxy(
    {},
    {
      get(_t, resource) {
        if (typeof resource !== "string" || resource === "then") return undefined;
        if (resource === "__name") return name;
        if (!resources.has(resource)) {
          resources.set(
            resource,
            new Proxy(
              {},
              {
                get(_r, method) {
                  if (typeof method !== "string" || method === "then") return undefined;
                  return async (...args: unknown[]) => {
                    const key = `${resource}.${method}`;
                    calls.push({ method: key, args });
                    const handler = handlers[key];
                    if (!handler) throw new Error(`unexpected Stripe call ${key} on ${name}`);
                    return handler(...args);
                  };
                },
              },
            ),
          );
        }
        return resources.get(resource);
      },
    },
  ) as unknown as Stripe;
  return {
    client,
    calls,
    /** The request options (last argument) of every call to `method`. */
    optionsOf(method: string): unknown[] {
      return calls.filter((c) => c.method === method).map((c) => c.args[c.args.length - 1]);
    },
    methods(): string[] {
      return calls.map((c) => c.method);
    },
  };
}

/** Errors shaped like stripe-node's. */
export const stripeErrors = {
  missing: () => Object.assign(new Error("No such object"), { type: "StripeInvalidRequestError", statusCode: 404, code: "resource_missing" }),
  permission: (rak: string, acct = "acct_founder") =>
    Object.assign(
      new Error(
        `The provided key 'rk_test_*****1234' does not have the required permissions for this endpoint on account '${acct}'. Having the 'rak_${rak}' permission would allow this request to continue.`,
      ),
      { type: "StripePermissionError", statusCode: 403 },
    ),
  auth: () => Object.assign(new Error("Invalid API Key provided"), { type: "StripeAuthenticationError", statusCode: 401 }),
};
