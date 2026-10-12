import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { createEmailClient, EmailSendError } = await import("./email");

const message = {
  from: '"Acme" <billing@mail.example.com>',
  to: "jamie@example.com",
  subject: "Please update your card",
  html: "<p>Hi</p>",
  text: "Hi",
  replyTo: "help@acme.com",
  idempotencyKey: "dunning/case-1/0",
  tags: { kind: "dunning", step: "1", category: "authentication_required" },
};

describe("email client", () => {
  it("falls back to logging when RESEND_API_KEY is missing", async () => {
    const lines: string[] = [];
    const fetch = vi.fn();
    const client = createEmailClient({ apiKey: "  ", fetch, log: (l) => lines.push(l) });
    expect(client.live).toBe(false);
    const result = await client.send(message);
    expect(result).toMatchObject({ delivered: false, reason: "no_api_key" });
    expect(fetch).not.toHaveBeenCalled();
    expect(lines[0]).toContain("to=jamie@example.com");
    expect(lines[0]).not.toContain("<p>Hi</p>"); // never dumps the body
  });

  it("sends through Resend's API with an idempotency key", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "re_123" }) }));
    const client = createEmailClient({ apiKey: "re_test_key", fetch });
    expect(client.live).toBe(true);
    await expect(client.send(message)).resolves.toEqual({ id: "re_123", delivered: true });

    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer re_test_key");
    expect(init.headers["Idempotency-Key"]).toBe("dunning/case-1/0");
    expect(JSON.parse(init.body)).toEqual({
      from: message.from,
      to: ["jamie@example.com"],
      subject: message.subject,
      html: message.html,
      text: message.text,
      reply_to: "help@acme.com",
      tags: [
        { name: "kind", value: "dunning" },
        { name: "step", value: "1" },
        { name: "category", value: "authentication_required" },
      ],
    });
  });

  it("marks rate limits and outages as retryable, and bad requests as not", async () => {
    const respond = (status: number) =>
      createEmailClient({ apiKey: "re_x", fetch: async () => ({ ok: false, status, json: async () => ({ message: "nope" }) }) });
    const err429 = await respond(429).send(message).catch((e) => e);
    expect(err429).toBeInstanceOf(EmailSendError);
    expect(err429.retryable).toBe(true);
    const err422 = await respond(422).send(message).catch((e) => e);
    expect(err422.retryable).toBe(false);
    expect(err422.message).toContain("nope");

    const offline = createEmailClient({ apiKey: "re_x", fetch: async () => { throw new Error("ECONNRESET"); } });
    const errNet = await offline.send(message).catch((e) => e);
    expect(errNet.retryable).toBe(true);
  });
});
