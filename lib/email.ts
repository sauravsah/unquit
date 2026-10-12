/**
 * Email client: Resend's REST API (https://resend.com/docs/api-reference/emails/send-email).
 *
 * With RESEND_API_KEY set, messages are sent through Resend. Without it, the
 * client falls back to writing a one-line summary to the server logs, so the
 * app (and the dunning sequence) still runs in development.
 *
 * Every send can carry an idempotency key: Resend returns the original result
 * instead of sending again if the same key is reused within 24 hours. The
 * dunning cron uses `dunning/<case id>/<step>`, so a retried or overlapping
 * run can never email a customer twice.
 */
import "server-only";
import { serverEnv } from "@/lib/env";

export type EmailMessage = {
  /** "Acme <billing@mail.example.com>". Must be on a domain verified in Resend. */
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  idempotencyKey?: string;
  /** Resend tags (ASCII letters, numbers, _ and - only). */
  tags?: Record<string, string>;
};

export type SendResult = { id: string; delivered: true } | { id: string; delivered: false; reason: "no_api_key" };

export class EmailSendError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** True for errors worth retrying later (rate limit, Resend outage). */
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface EmailClient {
  send(message: EmailMessage): Promise<SendResult>;
  /** False when RESEND_API_KEY is missing and messages are only logged. */
  readonly live: boolean;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const RESEND_URL = "https://api.resend.com/emails";
const TAG_SAFE = /[^A-Za-z0-9_-]/g;

export function createEmailClient(options: {
  apiKey: string;
  fetch?: FetchLike;
  log?: (line: string) => void;
}): EmailClient {
  const apiKey = options.apiKey.trim();
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const log = options.log ?? ((line: string) => console.info(line));

  if (apiKey === "") {
    let n = 0;
    return {
      live: false,
      async send(message) {
        const id = `logged_${Date.now()}_${++n}`;
        log(
          `[email:log] (no RESEND_API_KEY, not sent) id=${id} from=${JSON.stringify(message.from)} to=${message.to} ` +
            `subject=${JSON.stringify(message.subject)}`,
        );
        return { id, delivered: false, reason: "no_api_key" };
      },
    };
  }

  return {
    live: true,
    async send(message) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (message.idempotencyKey) headers["Idempotency-Key"] = message.idempotencyKey.slice(0, 256);

      const body: Record<string, unknown> = {
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      };
      if (message.replyTo) body.reply_to = message.replyTo;
      if (message.tags) {
        body.tags = Object.entries(message.tags).map(([name, value]) => ({
          name: name.replace(TAG_SAFE, "_"),
          value: value.replace(TAG_SAFE, "_").slice(0, 256),
        }));
      }

      let response: Awaited<ReturnType<FetchLike>>;
      try {
        response = await doFetch(RESEND_URL, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (error) {
        throw new EmailSendError(`Resend unreachable: ${error instanceof Error ? error.message : String(error)}`, 0, true);
      }

      const json = (await response.json().catch(() => null)) as { id?: string; message?: string; name?: string } | null;
      if (!response.ok || !json?.id) {
        const detail = json?.message ?? json?.name ?? "no details";
        throw new EmailSendError(
          `Resend rejected the email (${response.status}): ${detail}`,
          response.status,
          response.status === 429 || response.status >= 500 || response.status === 0,
        );
      }
      return { id: json.id, delivered: true };
    },
  };
}

let cached: EmailClient | null = null;

/** The app's email client, configured from RESEND_API_KEY. */
export function getEmailClient(): EmailClient {
  if (!cached) cached = createEmailClient({ apiKey: serverEnv.resendApiKey() });
  return cached;
}

export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  return getEmailClient().send(message);
}
