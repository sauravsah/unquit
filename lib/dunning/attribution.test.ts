import { describe, expect, it } from "vitest";
import { ATTRIBUTION_WINDOW_MS, decideAttribution } from "./attribution";

const started = new Date("2026-10-12T12:00:00Z");
const iso = (d: Date) => d.toISOString();
const plus = (ms: number) => new Date(started.getTime() + ms);

describe("decideAttribution", () => {
  it("credits a payment made with a card added on the update page (10% fee)", () => {
    const a = decideAttribution(
      { pendingAttribution: "update_link", pendingAttributionAt: iso(started), linkFirstOpenedAt: iso(plus(-60_000)) },
      plus(5_000),
      4_900,
    );
    expect(a).toMatchObject({ via: "update_link", billable: true, feeCents: 490 });
  });

  it("credits Unquit's retry only after the customer opened an email link", () => {
    const clicked = decideAttribution(
      { pendingAttribution: "unquit_retry", pendingAttributionAt: iso(started), linkFirstOpenedAt: iso(plus(-60_000)) },
      plus(3_000),
      10_000,
    );
    expect(clicked).toMatchObject({ via: "unquit_retry", billable: true, feeCents: 1_000 });

    const neverClicked = decideAttribution(
      { pendingAttribution: "unquit_retry", pendingAttributionAt: iso(started), linkFirstOpenedAt: null },
      plus(3_000),
      10_000,
    );
    expect(neverClicked).toMatchObject({ via: "external", billable: false, feeCents: 0 });
  });

  it("leaves Stripe's own recoveries external and free", () => {
    expect(decideAttribution({ pendingAttribution: null, pendingAttributionAt: null, linkFirstOpenedAt: iso(started) }, plus(1000), 4_900)).toMatchObject({
      via: "external",
      billable: false,
      feeCents: 0,
    });
  });

  it("doesn't credit a payment that lands outside the attribution window", () => {
    const input = { pendingAttribution: "update_link" as const, pendingAttributionAt: iso(started), linkFirstOpenedAt: iso(started) };
    expect(decideAttribution(input, plus(ATTRIBUTION_WINDOW_MS), 4_900).billable).toBe(true);
    expect(decideAttribution(input, plus(ATTRIBUTION_WINDOW_MS + 1), 4_900).via).toBe("external");
    expect(decideAttribution(input, plus(-5 * 60_000), 4_900).via).toBe("external"); // paid before we started
  });

  it("never bills a $0 recovery", () => {
    expect(
      decideAttribution({ pendingAttribution: "update_link", pendingAttributionAt: iso(started), linkFirstOpenedAt: iso(started) }, plus(1000), 0),
    ).toMatchObject({ via: "external", feeCents: 0 });
  });

  it("rounds the fee down", () => {
    expect(
      decideAttribution({ pendingAttribution: "update_link", pendingAttributionAt: iso(started), linkFirstOpenedAt: null }, plus(1000), 4_999)
        .feeCents,
    ).toBe(499);
  });
});
