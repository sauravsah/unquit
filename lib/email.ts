import "server-only";
import { serverEnv } from "@/lib/env";

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

/**
 * Email client — STUB for week 1.
 *
 * Logs the message instead of sending it. Week 3 (dunning emails) and week 4
 * (save receipts) replace the body with a real Resend call:
 *
 *   TODO(week 3): `npm i resend`, then
 *     const resend = new Resend(serverEnv.resendApiKey());
 *     await resend.emails.send({ from: "Unquit <receipts@yourdomain>", ...message });
 */
export async function sendEmail(message: EmailMessage): Promise<{ id: string; stubbed: true }> {
  const configured = serverEnv.resendApiKey() !== "";
  console.info(
    `[email:stub] ${configured ? "(RESEND_API_KEY set, but sending is not enabled yet)" : "(no RESEND_API_KEY)"} ` +
      `to=${message.to} subject=${JSON.stringify(message.subject)}`,
  );
  return { id: `stub_${Date.now()}`, stubbed: true };
}
