import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { breadcrumbFor, isActive } from "@/components/app-shell/nav";
import { StatusPill } from "./badge";
import { Button } from "./button";
import { DataTable, type Column } from "./data-table";
import { EmptyState } from "./empty-state";
import { formatNumber } from "./number-ticker";

describe("Button", () => {
  it("shows a spinner, keeps its label for width and blocks clicks while loading", () => {
    const html = renderToStaticMarkup(h(Button, { loading: true }, "Save"));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("animate-spin");
    expect(html).toContain("invisible");
    expect(html).toContain("Save");
  });

  it("renders its child with button styles when asChild", () => {
    const html = renderToStaticMarkup(h(Button, { asChild: true, variant: "brand" }, h("a", { href: "/login" }, "Go")));
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/login"');
    expect(html).toContain("shadow-glow-sm");
  });
});

describe("StatusPill", () => {
  it("maps statuses to tones", () => {
    expect(renderToStaticMarkup(h(StatusPill, { status: "verified" }))).toContain("text-brand-text");
    expect(renderToStaticMarkup(h(StatusPill, { status: "open" }))).toContain("animate-pulse-ring");
    const clawed = renderToStaticMarkup(h(StatusPill, { status: "clawed_back" }));
    expect(clawed).not.toContain("line-through");
    expect(clawed).toContain("text-danger");
    expect(clawed).toContain("clawed back");
  });

  it("falls back to neutral for unknown statuses", () => {
    expect(renderToStaticMarkup(h(StatusPill, { status: "mystery", label: "Hmm" }))).toContain("text-muted-foreground");
  });
});

describe("EmptyState", () => {
  it("renders title, description and action", () => {
    const html = renderToStaticMarkup(h(EmptyState, { title: "No saves yet", description: "Soon.", action: h("a", { href: "/x" }, "Do it") }));
    expect(html).toContain("No saves yet");
    expect(html).toContain("Soon.");
    expect(html).toContain('href="/x"');
    expect(html).toContain('aria-hidden="true"');
  });
});

describe("DataTable", () => {
  type Row = { id: string; name: string; amount: number };
  const columns: Column<Row>[] = [
    { id: "name", header: "Name", primary: true, cell: (r) => r.name, sortValue: (r) => r.name },
    { id: "amount", header: "Amount", align: "right", cell: (r) => String(r.amount), sortValue: (r) => r.amount },
  ];
  const rows: Row[] = [
    { id: "a", name: "Ada", amount: 10 },
    { id: "b", name: "Bob", amount: 30 },
    { id: "c", name: "Cy", amount: 20 },
  ];

  it("applies the initial sort and marks the sorted header", () => {
    const html = renderToStaticMarkup(h(DataTable<Row>, { columns, rows, getRowId: (r) => r.id, initialSort: { id: "amount", dir: "desc" } }));
    const table = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    expect(table.indexOf("Bob")).toBeLessThan(table.indexOf("Cy"));
    expect(table.indexOf("Cy")).toBeLessThan(table.indexOf("Ada"));
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain("sticky top-0");
  });

  it("renders mobile cards too, and the empty state when there are no rows", () => {
    const html = renderToStaticMarkup(h(DataTable<Row>, { columns, rows, getRowId: (r) => r.id }));
    expect(html).toContain("md:hidden");
    const empty = renderToStaticMarkup(h(DataTable<Row>, { columns, rows: [], getRowId: (r) => r.id, empty: h("p", null, "Nothing") }));
    expect(empty).toBe("<p>Nothing</p>");
  });
});

describe("formatNumber", () => {
  it("formats cents, percents and integers", () => {
    expect(formatNumber(431_200, "cents")).toBe("$4,312.00");
    expect(formatNumber(431_200, "cents", "usd", 0)).toBe("$4,312");
    expect(formatNumber(0.256, "percent")).toBe("26%");
    expect(formatNumber(12_345, "integer")).toBe("12,345");
  });
});

describe("dashboard nav", () => {
  it("matches the active page", () => {
    expect(isActive("/dashboard", "/dashboard")).toBe(true);
    expect(isActive("/dashboard/flows", "/dashboard")).toBe(false);
    expect(isActive("/dashboard/saves/UQ-0001042", "/dashboard/saves")).toBe(true);
  });

  it("builds breadcrumbs", () => {
    expect(breadcrumbFor("/dashboard")).toEqual(["Overview"]);
    expect(breadcrumbFor("/dashboard/dunning")).toEqual(["Failed payments"]);
    expect(breadcrumbFor("/dashboard/saves/UQ-0001042")).toEqual(["Saves & ledger", "UQ-0001042"]);
  });
});
