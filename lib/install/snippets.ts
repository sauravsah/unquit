/**
 * The code a founder's developer pastes in, pre-filled with the founder's
 * publishable key and this app's address. Used by /dashboard/install and the
 * public /install/<token> page, so both always show the same, correct code.
 *
 * Must match the real integration:
 *   - widget/entry.ts reads `data-unquit-key` from the <script> tag and calls
 *     the API on the script's own origin; Unquit.open({ customerId, subscriptionId, hmac })
 *     resolves to "saved" | "canceled" | "dismissed".
 *   - lib/widget/hmac.ts: HMAC-SHA256(signing secret, `${customerId}:${subscriptionId}`), lowercase hex.
 *
 * The signing secret is NEVER filled in here: it only ever appears as the
 * placeholder `uqsk_...`, because these snippets end up in a shareable page.
 */

export const SECRET_PLACEHOLDER = "uqsk_...";

export type SnippetInput = { appUrl: string; publishableKey: string };

export type Snippet = { id: string; title: string; language: string; filename?: string; code: string };

export function scriptTag({ appUrl, publishableKey }: SnippetInput): string {
  return `<script src="${appUrl.replace(/\/+$/, "")}/widget.js" data-unquit-key="${publishableKey}" defer></script>`;
}

export function envSnippet(): string {
  return `# Server environment only. Never commit it, never send it to the browser.
UNQUIT_SIGNING_SECRET=${SECRET_PLACEHOLDER}`;
}

export function nodeSnippet(): string {
  return `// Node.js (Express shown; any framework works). Never send the secret to the browser.
import { createHmac } from "node:crypto";

const UNQUIT_SIGNING_SECRET = process.env.UNQUIT_SIGNING_SECRET; // ${SECRET_PLACEHOLDER}

app.get("/api/unquit-signature", requireLogin, async (req, res) => {
  // Look these up from YOUR database for the logged-in user. Never trust ids sent by the browser.
  const { stripeCustomerId, stripeSubscriptionId } = await getBillingFor(req.user);
  const hmac = createHmac("sha256", UNQUIT_SIGNING_SECRET)
    .update(\`\${stripeCustomerId}:\${stripeSubscriptionId}\`)
    .digest("hex");
  res.json({ customerId: stripeCustomerId, subscriptionId: stripeSubscriptionId, hmac });
});`;
}

export function pythonSnippet(): string {
  return `# Python (Flask shown; any framework works). Never send the secret to the browser.
import hashlib
import hmac
import os

from flask import jsonify

UNQUIT_SIGNING_SECRET = os.environ["UNQUIT_SIGNING_SECRET"]  # ${SECRET_PLACEHOLDER}

@app.get("/api/unquit-signature")
@login_required
def unquit_signature():
    # Look these up from YOUR database for the logged-in user. Never trust ids sent by the browser.
    customer_id, subscription_id = get_billing_for(current_user)
    message = f"{customer_id}:{subscription_id}".encode()
    signature = hmac.new(UNQUIT_SIGNING_SECRET.encode(), message, hashlib.sha256).hexdigest()
    return jsonify(customerId=customer_id, subscriptionId=subscription_id, hmac=signature)`;
}

export function frontendSnippet(): string {
  return `// Runs in the browser, on the page with your Cancel button.
document.querySelector("#cancel-button").addEventListener("click", async () => {
  const auth = await fetch("/api/unquit-signature").then((r) => r.json());
  const result = await Unquit.open(auth); // { customerId, subscriptionId, hmac }
  // result.outcome is "saved" (offer accepted), "canceled", or "dismissed" (closed, nothing changed)
  if (result.outcome !== "dismissed") location.reload();
});`;
}

/** Every snippet, in the order the developer needs them. */
export function buildSnippets(input: SnippetInput) {
  return {
    script: { id: "script", title: "Script tag", language: "html", code: scriptTag(input) } satisfies Snippet,
    env: { id: "env", title: "Environment variable", language: "bash", filename: ".env", code: envSnippet() } satisfies Snippet,
    node: { id: "node", title: "Node.js / Express", language: "js", filename: "server.js", code: nodeSnippet() } satisfies Snippet,
    python: { id: "python", title: "Python / Flask", language: "python", filename: "app.py", code: pythonSnippet() } satisfies Snippet,
    frontend: { id: "frontend", title: "Cancel button", language: "js", code: frontendSnippet() } satisfies Snippet,
  };
}

/** Short message a founder can paste into Slack or email for their developer. */
export function developerMessage(link: string): string {
  return `Hi! We're adding Unquit to our cancel flow (it shows a retention offer when a customer clicks Cancel, and applies it in Stripe). It's about 15 minutes of work: one script tag, one small server endpoint that signs the customer, and a click handler on the Cancel button.

Everything you need, with our key already filled in, is here: ${link}

The one secret you need (the signing secret, uqsk_...) isn't on that page. I'll send it to you separately, so please keep it on the server only. Thanks!`;
}
