/**
 * public/widget.js entry point. Founders embed:
 *
 *   <script src="https://YOUR-APP/widget.js" data-unquit-key="pk_..."></script>
 *
 * and, when their user clicks Cancel:
 *
 *   Unquit.open({ customerId, subscriptionId, hmac })   // returns a Promise
 *
 * `hmac` is computed on the founder's server (see README) so an end user
 * can't open the flow for somebody else's subscription.
 */
import { mountFlow, type FlowHandle } from "./flow";
import type { AcceptResult, CancelResult, SessionConfig, WidgetApi, WidgetOutcome } from "./types";

type OpenOptions = {
  customerId: string;
  subscriptionId: string;
  hmac: string;
  /** Optional callback; the returned Promise resolves with the same value. */
  onComplete?: (outcome: WidgetOutcome) => void;
};

type Settings = { publishableKey: string | null; apiBase: string };

const script = document.currentScript as HTMLScriptElement | null;
const settings: Settings = {
  publishableKey: script?.dataset.unquitKey ?? null,
  apiBase: script?.src ? new URL(script.src).origin : window.location.origin,
};

let current: { handle: FlowHandle; host: HTMLElement } | null = null;

class WidgetError extends Error {}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${settings.apiBase}/api/widget/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
    });
  } catch {
    throw new WidgetError("We couldn't reach the server. Check your connection and try again.");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) throw new WidgetError(data.message ?? "Something went wrong. Please try again.");
  return data as T;
}

function createApi(options: OpenOptions): WidgetApi {
  const auth = {
    publishableKey: settings.publishableKey,
    customerId: options.customerId,
    subscriptionId: options.subscriptionId,
    hmac: options.hmac,
  };
  return {
    session: () => post<SessionConfig>("session", auth),
    accept: (input) => post<AcceptResult>("accept", { ...auth, ...input }),
    cancel: (input) => post<CancelResult>("cancel", { ...auth, ...input }),
  };
}

function open(options: OpenOptions): Promise<WidgetOutcome> {
  if (!settings.publishableKey) {
    return Promise.reject(new Error("unquit: add data-unquit-key=\"pk_...\" to the widget <script> tag."));
  }
  if (!options?.customerId || !options.subscriptionId || !options.hmac) {
    return Promise.reject(new Error("unquit: open() needs customerId, subscriptionId and hmac."));
  }
  close();
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.setAttribute("data-unquit", "");
    document.body.appendChild(host);
    const handle = mountFlow(host, {
      mode: "modal",
      api: createApi(options),
      onClose: (outcome) => {
        host.remove();
        if (current?.host === host) current = null;
        try {
          options.onComplete?.(outcome);
        } finally {
          resolve(outcome);
        }
      },
    });
    current = { handle, host };
  });
}

function close(): void {
  current?.handle.close();
}

/** For apps that load the script dynamically or proxy the API. */
function configure(next: { publishableKey?: string; apiBase?: string }): void {
  if (next.publishableKey) settings.publishableKey = next.publishableKey;
  if (next.apiBase) settings.apiBase = next.apiBase.replace(/\/+$/, "");
}

const Unquit = { open, close, configure, version: "2" };
(window as unknown as { Unquit: typeof Unquit }).Unquit = Unquit;
