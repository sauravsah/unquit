/**
 * A small, typed Dodo Payments REST client (just what unquit's own billing
 * uses). Plain fetch, no SDK: the test suite swaps the whole client for a
 * fake (lib/billing/dodo/testing.ts).
 *
 * API reference: https://docs.dodopayments.com/api-reference/introduction
 *   test mode  https://test.dodopayments.com
 *   live mode  https://live.dodopayments.com
 */

export type DodoEnvironment = "test_mode" | "live_mode";

export const DODO_BASE_URLS: Record<DodoEnvironment, string> = {
  test_mode: "https://test.dodopayments.com",
  live_mode: "https://live.dodopayments.com",
};

export type Metadata = Record<string, string>;

export type DodoSubscription = {
  subscription_id: string;
  status: string;
  product_id: string | null;
  customer_id: string | null;
  customer_email: string | null;
  on_demand: boolean;
  payment_method_id: string | null;
  metadata: Metadata;
};

export type DodoPayment = {
  payment_id: string;
  status: string | null;
  subscription_id: string | null;
  customer_id: string | null;
  total_amount: number | null;
  currency: string | null;
  error_code: string | null;
  error_message: string | null;
  invoice_url: string | null;
  card_last_four: string | null;
  card_network: string | null;
  is_update_payment_method: boolean;
  metadata: Metadata;
  created_at: string | null;
};

export type DodoPaymentMethod = { payment_method_id: string; brand: string | null; last4: string | null };

export interface DodoClient {
  readonly environment: DodoEnvironment;
  createCheckoutSession(input: {
    productId: string;
    customer: { customerId: string } | { email: string; name: string | null };
    returnUrl: string;
    metadata: Metadata;
  }): Promise<{ sessionId: string; checkoutUrl: string }>;
  getSubscription(subscriptionId: string): Promise<DodoSubscription | null>;
  updatePaymentMethod(subscriptionId: string, returnUrl: string): Promise<{ paymentLink: string | null; paymentId: string | null }>;
  chargeSubscription(subscriptionId: string, input: { amountCents: number; description: string; metadata: Metadata }): Promise<{ paymentId: string }>;
  getPayment(paymentId: string): Promise<DodoPayment | null>;
  /** Payments on a subscription created at or after `since` (reconciling an attempt whose response was lost). */
  listSubscriptionPayments(subscriptionId: string, since: Date): Promise<DodoPayment[]>;
  listCustomerPaymentMethods(customerId: string): Promise<DodoPaymentMethod[]>;
}

export class DodoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
  /** True when Dodo definitely did not create anything (a 4xx other than a timeout/conflict). */
  get definitelyNotCreated(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 409;
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function metadataOf(v: unknown): Metadata {
  if (!v || typeof v !== "object") return {};
  const out: Metadata = {};
  for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
    if (value !== null && value !== undefined) out[k] = String(value);
  }
  return out;
}

export function parseSubscription(raw: unknown): DodoSubscription {
  const r = (raw ?? {}) as Record<string, unknown>;
  const customer = (r.customer ?? {}) as Record<string, unknown>;
  const onDemand = r.on_demand;
  return {
    subscription_id: String(r.subscription_id ?? ""),
    status: String(r.status ?? ""),
    product_id: str(r.product_id),
    customer_id: str(customer.customer_id),
    customer_email: str(customer.email),
    on_demand: onDemand === true || (typeof onDemand === "object" && onDemand !== null),
    payment_method_id: str(r.payment_method_id),
    metadata: metadataOf(r.metadata),
  };
}

export function parsePayment(raw: unknown): DodoPayment {
  const r = (raw ?? {}) as Record<string, unknown>;
  const customer = (r.customer ?? {}) as Record<string, unknown>;
  return {
    payment_id: String(r.payment_id ?? ""),
    status: str(r.status),
    subscription_id: str(r.subscription_id),
    customer_id: str(customer.customer_id),
    total_amount: num(r.total_amount),
    currency: str(r.currency),
    error_code: str(r.error_code),
    error_message: str(r.error_message),
    invoice_url: str(r.invoice_url),
    card_last_four: str(r.card_last_four),
    card_network: str(r.card_network),
    is_update_payment_method: r.is_update_payment_method === true,
    metadata: metadataOf(r.metadata),
    created_at: str(r.created_at),
  };
}

function parsePaymentMethod(raw: unknown): DodoPaymentMethod {
  const r = (raw ?? {}) as Record<string, unknown>;
  const card = (r.card ?? {}) as Record<string, unknown>;
  const last4 = str(card.last4_digits) ?? str(card.last4) ?? str(card.last_four) ?? str(r.last4);
  return {
    payment_method_id: String(r.payment_method_id ?? ""),
    brand: str(card.card_network) ?? str(r.payment_method_type),
    last4: last4 && /^\d{4}$/.test(last4.slice(-4)) ? last4.slice(-4) : null,
  };
}

export function createDodoClient(options: { apiKey: string; environment: DodoEnvironment; fetch?: FetchLike; baseUrl?: string }): DodoClient {
  const base = (options.baseUrl ?? DODO_BASE_URLS[options.environment]).replace(/\/+$/, "");
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);

  async function call<T = unknown>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const d = (data ?? {}) as Record<string, unknown>;
      const code = str(d.code) ?? str(d.error_code);
      const message = str(d.message) ?? str(d.error) ?? `HTTP ${res.status}`;
      throw new DodoApiError(`Dodo ${method} ${path.split("?")[0]} failed (${res.status}${code ? ` ${code}` : ""}): ${message}`.slice(0, 500), res.status, code);
    }
    return data as T;
  }

  const enc = encodeURIComponent;

  return {
    environment: options.environment,

    async createCheckoutSession(input) {
      const customer = "customerId" in input.customer ? { customer_id: input.customer.customerId } : { email: input.customer.email, ...(input.customer.name ? { name: input.customer.name } : {}) };
      const data = await call<Record<string, unknown>>("POST", "/checkouts", {
        product_cart: [{ product_id: input.productId, quantity: 1 }],
        customer,
        return_url: input.returnUrl,
        metadata: input.metadata,
        subscription_data: { on_demand: { mandate_only: true } },
      });
      const sessionId = str(data?.session_id);
      const checkoutUrl = str(data?.checkout_url);
      if (!sessionId || !checkoutUrl) throw new DodoApiError("Dodo did not return a checkout URL", 502, null);
      return { sessionId, checkoutUrl };
    },

    async getSubscription(subscriptionId) {
      const data = await call("GET", `/subscriptions/${enc(subscriptionId)}`, undefined, true);
      return data ? parseSubscription(data) : null;
    },

    async updatePaymentMethod(subscriptionId, returnUrl) {
      const data = await call<Record<string, unknown>>("POST", `/subscriptions/${enc(subscriptionId)}/update-payment-method`, { type: "new", return_url: returnUrl });
      return { paymentLink: str(data?.payment_link), paymentId: str(data?.payment_id) };
    },

    async chargeSubscription(subscriptionId, input) {
      if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new RangeError(`charge amount must be positive cents, got ${input.amountCents}`);
      const data = await call<Record<string, unknown>>("POST", `/subscriptions/${enc(subscriptionId)}/charge`, {
        product_price: input.amountCents,
        product_currency: "USD",
        product_description: input.description.slice(0, 200),
        metadata: input.metadata,
      });
      const paymentId = str(data?.payment_id);
      if (!paymentId) throw new DodoApiError("Dodo did not return a payment id", 502, null);
      return { paymentId };
    },

    async getPayment(paymentId) {
      const data = await call("GET", `/payments/${enc(paymentId)}`, undefined, true);
      return data ? parsePayment(data) : null;
    },

    async listSubscriptionPayments(subscriptionId, since) {
      const data = await call<{ items?: unknown[] }>(
        "GET",
        `/payments?subscription_id=${enc(subscriptionId)}&created_at_gte=${enc(since.toISOString())}&page_size=100`,
      );
      return (data?.items ?? []).map(parsePayment);
    },

    async listCustomerPaymentMethods(customerId) {
      const data = await call<{ items?: unknown[] }>("GET", `/customers/${enc(customerId)}/payment-methods`, undefined, true);
      return (data?.items ?? []).map(parsePaymentMethod);
    },
  };
}
