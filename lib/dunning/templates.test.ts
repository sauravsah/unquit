import { describe, expect, it } from "vitest";
import { parseDunningSettings, settingsFromRow, settingsToRow } from "./settings";
import {
  DEFAULT_TEMPLATES,
  cloneDefaults,
  fillText,
  parseTemplates,
  renderEmail,
  resolveTemplates,
  templateOverrides,
  unknownVariables,
} from "./templates";

const vars = {
  customer_name: "Jamie",
  amount: "$49.00",
  update_link: "https://app.example.com/api/dunning/click/e1?t=v1.abc.def",
  company: "Acme & Co",
};

describe("default copy", () => {
  it("has 3 emails for each category, all carrying only known variables", () => {
    for (const list of Object.values(DEFAULT_TEMPLATES)) {
      expect(list).toHaveLength(3);
      for (const t of list) {
        expect(unknownVariables(t.subject + t.body)).toEqual([]);
        expect(t.body).toContain("{{customer_name}}");
        expect(t.body).toContain("{{amount}}");
      }
    }
  });

  it("is gentle for soft declines and asks for a new card for hard ones", () => {
    expect(DEFAULT_TEMPLATES.soft[0]!.body).toMatch(/don't need to do anything/i);
    expect(DEFAULT_TEMPLATES.hard[0]!.body).toMatch(/add a new card/i);
    expect(DEFAULT_TEMPLATES.authentication_required[0]!.body).toMatch(/confirm/i);
  });
});

describe("renderEmail", () => {
  const rendered = renderEmail(DEFAULT_TEMPLATES.hard[0]!, vars, { category: "hard", openPixelUrl: "https://app.example.com/api/dunning/open/e1" });

  it("fills the subject", () => {
    expect(rendered.subject).toBe("Please update your card for Acme & Co");
  });

  it("escapes values in HTML and keeps a working button + fallback link", () => {
    expect(rendered.html).toContain("Acme &amp; Co");
    expect(rendered.html).not.toContain("Acme & Co");
    expect(rendered.html).toContain('href="https://app.example.com/api/dunning/click/e1?t=v1.abc.def"');
    expect(rendered.html).toContain('bgcolor="#16A34A"'); // Outlook-safe button
    expect(rendered.html).toContain("Update your card");
    expect(rendered.html).toContain('role="presentation"');
    expect(rendered.html).toContain("https://app.example.com/api/dunning/open/e1");
    expect(rendered.html).not.toMatch(/\{\{/);
  });

  it("has a plain-text version with the link", () => {
    expect(rendered.text).toContain("Hi Jamie,");
    expect(rendered.text).toContain("$49.00");
    expect(rendered.text).toContain(`Update your card: ${vars.update_link}`);
    expect(rendered.text).not.toContain("<");
  });

  it("always includes the link even if the founder removed {{update_link}}", () => {
    const r = renderEmail({ subject: "Hi", body: "Please pay." }, vars, { category: "soft" });
    expect(r.html).toContain(vars.update_link);
    expect(r.text).toContain(vars.update_link);
  });

  it("turns an inline {{update_link}} into a link and blocks HTML injection from the body", () => {
    const r = renderEmail(
      { subject: "Hi {{customer_name}}", body: "Go to {{update_link}}\n\n<script>alert(1)</script>" },
      { ...vars, customer_name: '<img src=x onerror="x">' },
      { category: "authentication_required" },
    );
    expect(r.html).toContain(`<a href="${vars.update_link}"`);
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("<img src=x");
    expect(r.html).toContain("Confirm your payment");
    expect(r.subject).toBe('Hi <img src=x onerror="x">'); // subjects are plain text, never HTML
  });

  it("keeps single line breaks inside a paragraph", () => {
    const r = renderEmail({ subject: "s", body: "Thanks,\nThe team" }, vars, { category: "soft" });
    expect(r.html).toContain("Thanks,<br>The team");
  });
});

describe("variables", () => {
  it("fills known variables and leaves unknown ones visible", () => {
    expect(fillText("{{ company }} owes {{amount}} {{nope}}", vars)).toBe("Acme & Co owes $49.00 {{nope}}");
    expect(unknownVariables("{{company}} {{first_name}} {{nope}}")).toEqual(["first_name", "nope"]);
  });
});

describe("parseTemplates", () => {
  it("fills missing categories with the defaults", () => {
    const custom = cloneDefaults().hard.map((t) => ({ ...t, subject: `${t.subject}!` }));
    const parsed = parseTemplates({ hard: custom });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.hard[0]!.subject).toMatch(/!$/);
    expect(parsed.value.soft).toEqual(DEFAULT_TEMPLATES.soft);
  });

  it("rejects unknown variables, empty or oversized fields, multi-line subjects and wrong counts", () => {
    const base = cloneDefaults().soft;
    const cases: unknown[] = [
      { soft: [{ subject: "Hi {{first_name}}", body: "x" }, base[1], base[2]] },
      { soft: [{ subject: "", body: "x" }, base[1], base[2]] },
      { soft: [{ subject: "a\nb", body: "x" }, base[1], base[2]] },
      { soft: [{ subject: "ok", body: "x".repeat(5_001) }, base[1], base[2]] },
      { soft: [base[0], base[1]] },
      { weird: base },
      [],
    ];
    for (const input of cases) expect(parseTemplates(input).ok).toBe(false);
  });

  it("stores only what differs from the defaults and reads it back", () => {
    const set = cloneDefaults();
    expect(templateOverrides(set)).toEqual({});
    set.soft[1] = { subject: "Custom", body: "Hello {{customer_name}}" };
    const stored = templateOverrides(set);
    expect(Object.keys(stored)).toEqual(["soft"]);
    expect(resolveTemplates(stored).soft[1]).toEqual({ subject: "Custom", body: "Hello {{customer_name}}" });
    expect(resolveTemplates({ soft: "broken" })).toEqual(cloneDefaults());
  });
});

describe("settings", () => {
  it("defaults to OFF with the 0/3/7 schedule when the founder has no row", () => {
    const s = settingsFromRow(null);
    expect(s.enabled).toBe(false);
    expect(s.scheduleDays).toEqual([0, 3, 7]);
  });

  it("round-trips through the row shape", () => {
    const parsed = parseDunningSettings({ enabled: true, scheduleDays: [1, 4, 10], companyName: "  Acme   Inc ", replyToEmail: "help@acme.com" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.companyName).toBe("Acme Inc");
    const row = settingsToRow(parsed.value);
    expect(row).toMatchObject({ enabled: true, schedule_days: [1, 4, 10], company_name: "Acme Inc", templates: {} });
    expect(settingsFromRow(row)).toEqual(parsed.value);
  });

  it("needs a company name before emails can be switched on, and checks the rest", () => {
    expect(parseDunningSettings({ enabled: true, scheduleDays: [0, 3, 7] }).ok).toBe(false);
    expect(parseDunningSettings({ enabled: false, scheduleDays: [0, 3, 7] }).ok).toBe(true);
    expect(parseDunningSettings({ enabled: false, scheduleDays: [0, 7, 3] }).ok).toBe(false);
    expect(parseDunningSettings({ enabled: false, scheduleDays: [0, 3, 7], replyToEmail: "nope" }).ok).toBe(false);
    expect(parseDunningSettings({ enabled: false, scheduleDays: [0, 3, 7], companyName: 'Evil" <x@y.z>' }).ok).toBe(false);
    expect(parseDunningSettings(null).ok).toBe(false);
  });
});
