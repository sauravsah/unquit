import { describe, expect, it } from "vitest";
import { categorizeDecline, describeDeclineCode, primaryDeclineCode } from "./declines";

describe("categorizeDecline", () => {
  it.each(["insufficient_funds", "processing_error", "try_again_later", "issuer_not_available", "reenter_transaction", "card_velocity_exceeded"])(
    "treats %s as soft",
    (code) => {
      expect(categorizeDecline({ declineCode: code, errorCode: "card_declined" })).toBe("soft");
    },
  );

  it.each(["expired_card", "do_not_honor", "lost_card", "stolen_card", "pickup_card", "fraudulent", "generic_decline", "incorrect_cvc"])(
    "treats %s as hard",
    (code) => {
      expect(categorizeDecline({ declineCode: code, errorCode: "card_declined" })).toBe("hard");
    },
  );

  it("treats SCA failures as authentication_required", () => {
    expect(categorizeDecline({ declineCode: "authentication_required", errorCode: "card_declined" })).toBe("authentication_required");
    expect(categorizeDecline({ errorCode: "invoice_payment_intent_requires_action" })).toBe("authentication_required");
    expect(categorizeDecline({ errorCode: "payment_intent_authentication_failure" })).toBe("authentication_required");
  });

  it("uses Stripe's error code when there is no issuer decline code", () => {
    expect(categorizeDecline({ errorCode: "expired_card" })).toBe("hard");
    expect(categorizeDecline({ errorCode: "card_declined" })).toBe("hard");
    expect(categorizeDecline({ errorCode: "processing_error" })).toBe("soft");
  });

  it("prefers the more specific decline code over the generic error code", () => {
    expect(categorizeDecline({ declineCode: "insufficient_funds", errorCode: "card_declined" })).toBe("soft");
  });

  it("falls back to the error code when the decline code is unknown", () => {
    expect(categorizeDecline({ declineCode: "brand_new_reason", errorCode: "processing_error" })).toBe("soft");
  });

  it("asks for a new card when nothing is known", () => {
    expect(categorizeDecline({})).toBe("hard");
    expect(categorizeDecline({ declineCode: "", errorCode: null })).toBe("hard");
    expect(categorizeDecline({ declineCode: "something_new" })).toBe("hard");
  });

  it("is case and whitespace tolerant", () => {
    expect(categorizeDecline({ declineCode: " Insufficient_Funds " })).toBe("soft");
  });
});

describe("decline code display", () => {
  it("picks the most useful code", () => {
    expect(primaryDeclineCode({ declineCode: "insufficient_funds", errorCode: "card_declined" })).toBe("insufficient_funds");
    expect(primaryDeclineCode({ errorCode: "expired_card" })).toBe("expired_card");
    expect(primaryDeclineCode({})).toBeNull();
  });

  it("labels codes in plain English", () => {
    expect(describeDeclineCode("insufficient_funds")).toBe("Insufficient funds");
    expect(describeDeclineCode("withdrawal_count_limit_exceeded")).toBe("Withdrawal count limit exceeded");
    expect(describeDeclineCode(null)).toBe("Unknown reason");
  });
});
