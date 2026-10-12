import { describe, expect, it } from "vitest";
import { CSV_HEADER, centsToDecimal, csvCell, ledgerToCsv, type LedgerCsvRow } from "./csv";

const row = (over: Partial<LedgerCsvRow> = {}): LedgerCsvRow => ({
  receipt_number: "UQ-0001001",
  type: "cancel",
  status: "verified",
  customer_email: "jamie@example.com",
  stripe_customer_id: "cus_1",
  stripe_subscription_id: "sub_1",
  stripe_invoice_id: "in_1",
  offer: { type: "discount", percent_off: 30, months: 3 },
  attributed_via: null,
  saved_mrr_cents: 3_430,
  recovered_amount_cents: 0,
  currency: "usd",
  fee_cents: 1_372,
  clawed_back_cents: 0,
  fee_months: 2,
  lost_reason: null,
  verified_at: "2026-09-01T00:00:00.000Z",
  created_at: "2026-08-10T12:00:00.000Z",
  ...over,
});

describe("ledger CSV export", () => {
  it("writes a header and one row per save, money as plain decimals", () => {
    const csv = ledgerToCsv([row(), row({ receipt_number: "UQ-0001002", type: "dunning", offer: null, attributed_via: "update_link", saved_mrr_cents: 0, recovered_amount_cents: 4_900, fee_cents: 490, fee_months: 1 })]);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(CSV_HEADER.join(","));
    expect(lines[1]).toBe(
      "UQ-0001001,cancel,verified,jamie@example.com,cus_1,sub_1,in_1,30% off × 3 mo,34.30,,USD,2,13.72,0.00,,2026-09-01T00:00:00.000Z,2026-08-10T12:00:00.000Z",
    );
    expect(lines[2]).toBe(
      "UQ-0001002,dunning,verified,jamie@example.com,cus_1,sub_1,in_1,Card-update link,,49.00,USD,1,4.90,0.00,,2026-09-01T00:00:00.000Z,2026-08-10T12:00:00.000Z",
    );
    expect(lines[3]).toBe(""); // trailing CRLF
    expect(lines).toHaveLength(4);
  });

  it("quotes commas, quotes and newlines (RFC 4180)", () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(" padded ")).toBe('" padded "');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  it("neutralises spreadsheet formulas in text cells", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).toBe("\"'=HYPERLINK(\"\"http://evil\"\")\"");
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    const csv = ledgerToCsv([row({ customer_email: "=cmd|' /C calc'!A0" })]);
    expect(csv).toContain(",'=cmd|' /C calc'!A0,");
  });

  it("formats cents exactly", () => {
    expect(centsToDecimal(0)).toBe("0.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(123_456)).toBe("1234.56");
  });

  it("exports an empty ledger as just the header", () => {
    expect(ledgerToCsv([])).toBe(CSV_HEADER.join(",") + "\r\n");
  });
});
