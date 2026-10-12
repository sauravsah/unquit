import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacMessage, signCustomer, verifyCustomerHmac } from "./hmac";

const SECRET = "uqsk_test_secret_value";
const CUS = "cus_Abc123";
const SUB = "sub_Xyz789";

describe("widget HMAC", () => {
  it("signs `customerId:subscriptionId` with HMAC-SHA256 as lowercase hex (what the README tells founders)", () => {
    const expected = createHmac("sha256", SECRET).update(`${CUS}:${SUB}`).digest("hex");
    expect(hmacMessage(CUS, SUB)).toBe(`${CUS}:${SUB}`);
    expect(signCustomer(SECRET, CUS, SUB)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a valid signature (also in uppercase hex)", () => {
    const sig = signCustomer(SECRET, CUS, SUB);
    expect(verifyCustomerHmac(SECRET, CUS, SUB, sig)).toBe(true);
    expect(verifyCustomerHmac(SECRET, CUS, SUB, sig.toUpperCase())).toBe(true);
  });

  it("rejects a signature for another customer or subscription (no spoofing)", () => {
    const sig = signCustomer(SECRET, CUS, SUB);
    expect(verifyCustomerHmac(SECRET, "cus_Victim", SUB, sig)).toBe(false);
    expect(verifyCustomerHmac(SECRET, CUS, "sub_Victim", sig)).toBe(false);
  });

  it("rejects a signature made with a different (or rotated) secret", () => {
    expect(verifyCustomerHmac(SECRET, CUS, SUB, signCustomer("uqsk_other", CUS, SUB))).toBe(false);
  });

  it("can't be fooled by moving characters across the delimiter", () => {
    // Without a delimiter "cus_A"+"bsub_1" and "cus_Ab"+"sub_1" would sign the same bytes.
    const sig = signCustomer(SECRET, "cus_Ab", "sub_1");
    expect(verifyCustomerHmac(SECRET, "cus_A", "bsub_1", sig)).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    const sig = signCustomer(SECRET, CUS, SUB);
    expect(verifyCustomerHmac(SECRET, CUS, SUB, "")).toBe(false);
    expect(verifyCustomerHmac(SECRET, CUS, SUB, sig.slice(0, 63))).toBe(false);
    expect(verifyCustomerHmac(SECRET, CUS, SUB, `${sig.slice(0, 63)}z`)).toBe(false);
    expect(verifyCustomerHmac(SECRET, CUS, SUB, 12345)).toBe(false);
    expect(verifyCustomerHmac(SECRET, undefined, SUB, sig)).toBe(false);
    expect(verifyCustomerHmac(SECRET, "cus_bad:id", SUB, sig)).toBe(false);
    expect(verifyCustomerHmac(null, CUS, SUB, sig)).toBe(false);
    expect(verifyCustomerHmac("", CUS, SUB, sig)).toBe(false);
  });
});
