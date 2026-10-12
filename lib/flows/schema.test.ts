import { describe, expect, it } from "vitest";
import { flowFromRow, flowToRow, parseFlowConfig } from "./schema";
import { DEFAULT_FLOW, DEFAULT_REASONS, TEMPLATES, applyTemplate, templateFlow } from "./templates";

describe("default flow and templates", () => {
  it("ships the six default reasons, with free text on Other", () => {
    expect(DEFAULT_FLOW.reasons.map((r) => r.label)).toEqual([
      "Too expensive",
      "Not using it enough",
      "Missing a feature",
      "Switching to another tool",
      "Technical issues",
      "Other",
    ]);
    expect(DEFAULT_FLOW.reasons.find((r) => r.id === "other")?.freeText).toBe(true);
    expect(DEFAULT_FLOW.cancelMode).toBe("period_end");
    expect(DEFAULT_FLOW.offerCooldownDays).toBe(90);
  });

  it("has three templates that all validate", () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(["Discount-first", "Pause-first", "Balanced"]);
    for (const t of TEMPLATES) expect(parseFlowConfig(templateFlow(t.id)).ok).toBe(true);
  });

  it("applyTemplate keeps the founder's custom reasons and their offers", () => {
    const custom = { id: "custom_1", label: "Company closed", offer: { type: "none" as const } };
    const reasons = applyTemplate("pause_first", [...templateFlow("balanced").reasons, custom]);
    expect(reasons.find((r) => r.id === "too_expensive")?.offer.type).toBe("pause");
    expect(reasons.at(-1)).toEqual(custom);
    expect(reasons).toHaveLength(DEFAULT_REASONS.length + 1);
  });
});

describe("parseFlowConfig", () => {
  it("round-trips a valid flow through the database row shape", () => {
    const flow = templateFlow("discount_first");
    expect(flowFromRow(flowToRow(flow))).toEqual(flow);
  });

  it("rejects out-of-range offers", () => {
    const bad = (offer: unknown) =>
      parseFlowConfig({ ...DEFAULT_FLOW, reasons: [{ id: "x", label: "X", offer }] });
    expect(bad({ type: "discount", percentOff: 100, months: 3 }).ok).toBe(false); // $0 invoices never verify
    expect(bad({ type: "discount", percentOff: 30, months: 0 }).ok).toBe(false);
    expect(bad({ type: "discount", percentOff: 12.5, months: 3 }).ok).toBe(false);
    expect(bad({ type: "pause", months: 4 }).ok).toBe(false); // spec: 1–3 months
    expect(bad({ type: "downgrade", priceId: "" }).ok).toBe(false);
    expect(bad({ type: "free_money" }).ok).toBe(false);
    expect(bad({ type: "pause", months: 3 }).ok).toBe(true);
    expect(bad({ type: "downgrade", priceId: "price_123abc" }).ok).toBe(true);
  });

  it("rejects bad reason lists", () => {
    expect(parseFlowConfig({ ...DEFAULT_FLOW, reasons: [] }).ok).toBe(false);
    const dup = { id: "a", label: "A", offer: { type: "none" } };
    expect(parseFlowConfig({ ...DEFAULT_FLOW, reasons: [dup, dup] }).ok).toBe(false);
    expect(parseFlowConfig({ ...DEFAULT_FLOW, reasons: [{ ...dup, id: "Bad Id" }] }).ok).toBe(false);
    expect(parseFlowConfig({ ...DEFAULT_FLOW, reasons: [{ ...dup, label: "  " }] }).ok).toBe(false);
    const many = Array.from({ length: 11 }, (_, i) => ({ ...dup, id: `r${i}` }));
    expect(parseFlowConfig({ ...DEFAULT_FLOW, reasons: many }).ok).toBe(false);
  });

  it("validates settings", () => {
    expect(parseFlowConfig({ ...DEFAULT_FLOW, cancelMode: "whenever" }).ok).toBe(false);
    expect(parseFlowConfig({ ...DEFAULT_FLOW, offerCooldownDays: -1 }).ok).toBe(false);
    expect(parseFlowConfig({ ...DEFAULT_FLOW, offerCooldownDays: 0 }).ok).toBe(true);
    const r = parseFlowConfig({ ...DEFAULT_FLOW, cancelMode: "immediately", offerCooldownDays: 30 });
    expect(r.ok && r.value.cancelMode === "immediately" && r.value.offerCooldownDays === 30).toBe(true);
  });

  it("falls back to the default flow for a missing or corrupt stored row", () => {
    expect(flowFromRow(null)).toEqual(DEFAULT_FLOW);
    const warn = console.warn;
    console.warn = () => undefined;
    expect(flowFromRow({ template: "balanced", reasons: "nope", cancel_mode: "period_end", offer_cooldown_days: 90 })).toEqual(
      DEFAULT_FLOW,
    );
    console.warn = warn;
  });
});
