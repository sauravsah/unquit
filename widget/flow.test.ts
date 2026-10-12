// @vitest-environment jsdom
/**
 * The widget's DOM behaviour: steps, shadow-DOM isolation, focus trap, ESC,
 * ARIA, and the exact requests public/widget.js sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountFlow, type FlowHandle, type MountOptions } from "./flow";
import type { SessionConfig, WidgetApi, WidgetOutcome } from "./types";

const CONFIG: SessionConfig = {
  sessionId: "00000000-0000-4000-8000-000000000001",
  offersEnabled: true,
  cancelMode: "period_end",
  periodEndsOn: "May 20, 2026",
  reasons: [
    { id: "too_expensive", label: "Too expensive", freeText: false },
    { id: "other", label: "Other", freeText: true },
  ],
  offers: { too_expensive: { type: "discount", percentOff: 30, months: 3 }, other: null },
};

function fakeApi(config: SessionConfig = CONFIG) {
  return {
    session: vi.fn<WidgetApi["session"]>(async () => config),
    accept: vi.fn<WidgetApi["accept"]>(async ({ reasonId }) => ({ outcome: "saved", offer: config.offers[reasonId]! })),
    cancel: vi.fn<WidgetApi["cancel"]>(async () => ({ outcome: "canceled", mode: "period_end", endsOn: "May 20, 2026" })),
  };
}

const handles: FlowHandle[] = [];
const mount = (target: HTMLElement, options: MountOptions) => handles.push(mountFlow(target, options));

const tick = () => new Promise((r) => setTimeout(r, 0));
let host: HTMLElement;
let opener: HTMLButtonElement;

const shadow = () => host.shadowRoot!;
const q = <T extends Element = HTMLElement>(sel: string) => shadow().querySelector<T>(sel);
const buttonNamed = (name: string) =>
  Array.from(shadow().querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === name)!;
const heading = () => q("h2")?.textContent;
const press = (key: string, shiftKey = false) =>
  (shadow().activeElement ?? q(".uq-card"))!.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, composed: true }));
const pick = async (reasonId: string) => {
  const radio = Array.from(shadow().querySelectorAll<HTMLInputElement>("input[type=radio]")).find((r) => r.value === reasonId)!;
  radio.checked = true;
  radio.dispatchEvent(new Event("change", { bubbles: true }));
  await tick();
};

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.style.overflow = "";
  document.head.innerHTML = '<style>button{color:red!important;display:none!important}</style>';
  opener = document.createElement("button");
  opener.textContent = "Cancel plan";
  document.body.appendChild(opener);
  opener.focus();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  handles.splice(0).forEach((h) => h.close());
  vi.restoreAllMocks();
});

describe("modal flow", () => {
  it("renders an accessible dialog inside a shadow root", async () => {
    mount(host, { mode: "modal", api: fakeApi() });
    await tick();
    const dialog = q(".uq-card")!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("uq-title");
    expect(q("#uq-title")!.textContent).toBe("Before you go");
    expect(q("[aria-label=Close]")).not.toBeNull();
    // Styles live in the shadow root; nothing is injected into the host page.
    expect(shadow().querySelector("style")!.textContent).toContain(":host{all:initial}");
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
    // Reasons are real radio buttons in a fieldset with a legend.
    expect(shadow().querySelectorAll("fieldset input[type=radio]")).toHaveLength(2);
    expect(q("legend")!.textContent).toBe("Reason for cancelling");
    // Focus moved into the dialog and page scroll is locked.
    expect(shadow().activeElement).toBe(q("h2"));
    expect(document.documentElement.style.overflow).toBe("hidden");
  });

  it("survey → reason-matched offer → accept → confirmation", async () => {
    const api = fakeApi();
    const outcomes: WidgetOutcome[] = [];
    mount(host, { mode: "modal", api, onClose: (o) => outcomes.push(o) });
    await tick();

    expect(buttonNamed("Continue").disabled).toBe(true);
    await pick("too_expensive");
    buttonNamed("Continue").click();
    expect(heading()).toBe("How about 30% off?");
    expect(buttonNamed("No thanks, cancel")).toBeDefined();

    buttonNamed("Accept 30% off").click();
    await tick();
    expect(api.accept).toHaveBeenCalledWith({ sessionId: CONFIG.sessionId, reasonId: "too_expensive", reasonDetail: "" });
    expect(heading()).toBe("Thanks for staying!");

    buttonNamed("Done").click();
    expect(outcomes).toEqual([{ outcome: "saved", offer: { type: "discount", percentOff: 30, months: 3 } }]);
    expect(shadow().childNodes).toHaveLength(0);
    expect(document.documentElement.style.overflow).toBe("");
  });

  it("'No thanks, cancel' cancels and shows the cancellation confirmation", async () => {
    const api = fakeApi();
    mount(host, { mode: "modal", api });
    await tick();
    await pick("too_expensive");
    buttonNamed("Continue").click();
    buttonNamed("No thanks, cancel").click();
    await tick();
    expect(api.cancel).toHaveBeenCalledTimes(1);
    expect(heading()).toBe("Your subscription is cancelled");
    expect(q("#uq-desc")!.textContent).toContain("May 20, 2026");
  });

  it("a reason without an offer asks for confirmation before cancelling, and sends the free text", async () => {
    const api = fakeApi();
    mount(host, { mode: "modal", api });
    await tick();
    await pick("other");
    const textarea = q<HTMLTextAreaElement>("textarea")!;
    expect(q(`label[for=uq-detail]`)).not.toBeNull();
    textarea.value = "Closing the company";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    buttonNamed("Continue").click();
    expect(heading()).toBe("Cancel your subscription?");
    expect(api.cancel).not.toHaveBeenCalled();
    buttonNamed("Cancel subscription").click();
    await tick();
    expect(api.cancel).toHaveBeenCalledWith({ sessionId: CONFIG.sessionId, reasonId: "other", reasonDetail: "Closing the company" });
  });

  it("skips offers entirely when the abuse guard is on", async () => {
    mount(host, { mode: "modal", api: fakeApi({ ...CONFIG, offersEnabled: false }) });
    await tick();
    await pick("too_expensive");
    buttonNamed("Continue").click();
    expect(heading()).toBe("Cancel your subscription?");
  });

  it("shows server errors inline and lets the customer retry", async () => {
    const api = fakeApi();
    api.accept.mockRejectedValueOnce(new Error("This offer isn't available on your subscription right now."));
    mount(host, { mode: "modal", api });
    await tick();
    await pick("too_expensive");
    buttonNamed("Continue").click();
    buttonNamed("Accept 30% off").click();
    await tick();
    expect(q("[role=alert]")!.textContent).toBe("This offer isn't available on your subscription right now.");
    expect(heading()).toBe("How about 30% off?");
  });

  it("closes on ESC as 'dismissed' (nothing is cancelled) and returns focus to the page", async () => {
    const api = fakeApi();
    const onClose = vi.fn();
    mount(host, { mode: "modal", api, onClose });
    await tick();
    press("Escape");
    expect(onClose).toHaveBeenCalledWith({ outcome: "dismissed" });
    expect(api.cancel).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("traps Tab focus inside the dialog", async () => {
    mount(host, { mode: "modal", api: fakeApi() });
    await tick();
    await pick("too_expensive");
    const focusables = Array.from(shadow().querySelectorAll<HTMLElement>("button:not([disabled]),input"));
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    expect(first.getAttribute("aria-label")).toBe("Close");

    last.focus();
    press("Tab");
    expect(shadow().activeElement).toBe(first);
    press("Tab", true);
    expect(shadow().activeElement).toBe(last);
  });

  it("pulls focus back if it escapes to the host page", async () => {
    mount(host, { mode: "modal", api: fakeApi() });
    await tick();
    opener.focus();
    expect(document.activeElement).toBe(host);
  });
});

describe("inline mode (flow editor preview)", () => {
  it("renders the same flow without overlay, scroll lock or focus stealing", async () => {
    mount(host, { mode: "inline", api: fakeApi() });
    await tick();
    expect(q(".uq-inline")).not.toBeNull();
    expect(q(".uq-overlay")).toBeNull();
    expect(q(".uq-card")!.hasAttribute("aria-modal")).toBe(false);
    expect(document.documentElement.style.overflow).toBe("");
    expect(document.activeElement).toBe(opener);
    expect(heading()).toBe("Before you go");
  });
});

describe("public/widget.js entry", () => {
  it("exposes Unquit.open and sends key + customer + hmac with every request", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push({ url, body });
        const payload = url.endsWith("/session") ? CONFIG : { outcome: "canceled", mode: "period_end", endsOn: null };
        return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await import("./entry");
    const Unquit = (window as unknown as { Unquit: { open: (o: unknown) => Promise<WidgetOutcome>; configure: (o: unknown) => void } })
      .Unquit;

    await expect(Unquit.open({ customerId: "cus_1", subscriptionId: "sub_1", hmac: "ab" })).rejects.toThrow(/data-unquit-key/);

    Unquit.configure({ publishableKey: "pk_test", apiBase: "https://app.example.com/" });
    const done = Unquit.open({ customerId: "cus_1", subscriptionId: "sub_1", hmac: "f".repeat(64) });
    await tick();
    const widgetHost = document.querySelector<HTMLElement>("[data-unquit]")!;
    expect(widgetHost.shadowRoot!.querySelector("h2")!.textContent).toBe("Before you go");
    widgetHost.shadowRoot!.querySelector<HTMLElement>("[aria-label=Close]")!.click();
    await expect(done).resolves.toEqual({ outcome: "dismissed" });
    expect(document.querySelector("[data-unquit]")).toBeNull();

    expect(calls).toEqual([
      {
        url: "https://app.example.com/api/widget/session",
        body: { publishableKey: "pk_test", customerId: "cus_1", subscriptionId: "sub_1", hmac: "f".repeat(64) },
      },
    ]);
    vi.unstubAllGlobals();
  });
});
