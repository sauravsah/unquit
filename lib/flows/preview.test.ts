import { describe, expect, it } from "vitest";
import { buildPreviewSession, createPreviewApi } from "./preview";
import { templateFlow } from "./templates";

const NOW = new Date("2026-03-10T09:00:00Z");

describe("editor preview", () => {
  it("builds the same session shape the real API returns, with the same offer rules", () => {
    const session = buildPreviewSession(templateFlow("balanced"), [], { offersEnabled: true, now: NOW });
    expect(session.reasons.map((r) => r.id)).toEqual([
      "too_expensive",
      "not_using",
      "missing_feature",
      "switching",
      "technical_issues",
      "other",
    ]);
    expect(session.offers.too_expensive).toEqual({ type: "discount", percentOff: 30, months: 3 });
    expect(session.offers.not_using).toEqual({ type: "pause", months: 2, resumesOn: "May 10, 2026" });
    expect(session.periodEndsOn).toBe("March 28, 2026");
  });

  it("previews the abuse-guard path with no offers", () => {
    const session = buildPreviewSession(templateFlow("discount_first"), [], { offersEnabled: false, now: NOW });
    expect(Object.values(session.offers).every((o) => o === null)).toBe(true);
  });

  it("previews a downgrade to one of the founder's real prices", () => {
    const flow = templateFlow("balanced");
    flow.reasons[0] = { ...flow.reasons[0]!, offer: { type: "downgrade", priceId: "price_basic" } };
    const session = buildPreviewSession(
      flow,
      [
        {
          id: "price_basic",
          active: true,
          currency: "usd",
          productName: "Basic",
          unitAmountCents: 1_900,
          interval: "month",
          intervalCount: 1,
          monthlyUnitCents: 1_900,
        },
      ],
      { offersEnabled: true, now: NOW },
    );
    expect(session.offers.too_expensive).toEqual({ type: "downgrade", planName: "Basic", amountLabel: "$19.00/month" });
  });

  it("has a fake API that never leaves the browser", async () => {
    const session = buildPreviewSession(templateFlow("balanced"), [], { offersEnabled: true, now: NOW });
    const api = createPreviewApi(session, 0);
    await expect(api.accept({ sessionId: session.sessionId, reasonId: "not_using", reasonDetail: "" })).resolves.toMatchObject({
      outcome: "saved",
      offer: { type: "pause" },
    });
    await expect(api.cancel({ sessionId: session.sessionId, reasonId: "other", reasonDetail: "" })).resolves.toEqual({
      outcome: "canceled",
      mode: "period_end",
      endsOn: "March 28, 2026",
    });
  });
});
