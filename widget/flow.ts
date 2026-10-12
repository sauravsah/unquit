/**
 * The cancel flow: state machine + DOM rendering, framework-free.
 *
 * Used in two places, with exactly the same code:
 *   • public/widget.js        mode "modal"  (real API, on the founder's site)
 *   • /dashboard/flows editor mode "inline" (mock API, live preview)
 *
 * Everything renders inside a shadow root so host-page CSS can't touch it.
 * All text is set with textContent (never innerHTML), so founder- or
 * customer-supplied strings can't inject markup.
 */
import { acceptLabel, offerBody, offerHeadline, savedSummary } from "./copy";
import { WIDGET_CSS } from "./styles";
import type { CancelResult, OfferView, SessionConfig, WidgetApi, WidgetOutcome } from "./types";

export type FlowMode = "modal" | "inline";

export type MountOptions = {
  mode: FlowMode;
  api: WidgetApi;
  /** Called once when the flow closes (any reason). */
  onClose?: (outcome: WidgetOutcome) => void;
};

export type FlowHandle = { close: () => void };

type Step =
  | { name: "loading" }
  | { name: "survey" }
  | { name: "offer"; offer: OfferView }
  | { name: "confirm" }
  | { name: "working"; text: string }
  | { name: "saved"; offer: OfferView }
  | { name: "canceled"; result: CancelResult }
  | { name: "fatal"; message: string };

const MAX_DETAIL = 500;
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[href],[tabindex]:not([tabindex="-1"])';

type Child = Node | string | null | undefined | false;

/** Tiny hyperscript helper. Attributes starting with "on" become listeners. */
function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === "className") {
      el.className = String(value);
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return "Something went wrong. Please try again.";
}

export function mountFlow(host: HTMLElement, options: MountOptions): FlowHandle {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  shadow.replaceChildren();
  const style = document.createElement("style");
  style.textContent = WIDGET_CSS;
  const root = h("div", { className: "uq-root" });
  shadow.append(style, root);

  const modal = options.mode === "modal";
  const previouslyFocused = modal ? (document.activeElement as HTMLElement | null) : null;
  const previousOverflow = document.documentElement.style.overflow;
  if (modal) document.documentElement.style.overflow = "hidden";

  let config: SessionConfig | null = null;
  let step: Step = { name: "loading" };
  let reasonId = "";
  let detail = "";
  let inlineError = "";
  let closed = false;
  let finalOutcome: WidgetOutcome = { outcome: "dismissed" };

  // ---------------------------------------------------------------- lifecycle
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("focusin", keepFocusInside, true);
    if (modal) {
      document.documentElement.style.overflow = previousOverflow;
      shadow.replaceChildren();
      previouslyFocused?.focus?.();
    }
    options.onClose?.(finalOutcome);
  }

  function go(next: Step) {
    step = next;
    render();
  }

  async function load() {
    go({ name: "loading" });
    try {
      config = await options.api.session();
      go({ name: "survey" });
    } catch (error) {
      go({ name: "fatal", message: errorMessage(error) });
    }
  }

  function selectedReason() {
    return config?.reasons.find((r) => r.id === reasonId) ?? null;
  }

  function submitSurvey() {
    if (!config || !reasonId) return;
    inlineError = "";
    const offer = config.offersEnabled ? config.offers[reasonId] ?? null : null;
    go(offer ? { name: "offer", offer } : { name: "confirm" });
  }

  async function accept(offer: OfferView) {
    if (!config) return;
    inlineError = "";
    go({ name: "working", text: "Applying your offer…" });
    try {
      const result = await options.api.accept({ sessionId: config.sessionId, reasonId, reasonDetail: detail });
      finalOutcome = { outcome: "saved", offer: result.offer };
      go({ name: "saved", offer: result.offer });
    } catch (error) {
      inlineError = errorMessage(error);
      go({ name: "offer", offer });
    }
  }

  async function cancel(back: Step) {
    if (!config) return;
    inlineError = "";
    go({ name: "working", text: "Cancelling your subscription…" });
    try {
      const result = await options.api.cancel({ sessionId: config.sessionId, reasonId, reasonDetail: detail });
      finalOutcome = { outcome: "canceled", mode: result.mode, endsOn: result.endsOn };
      go({ name: "canceled", result });
    } catch (error) {
      inlineError = errorMessage(error);
      go(back);
    }
  }

  // ------------------------------------------------------------ accessibility
  function focusables(): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("hidden"));
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && modal) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== "Tab" || !modal) return;
    const items = focusables();
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = shadow.activeElement as HTMLElement | null;
    const inside = active ? items.includes(active) : false;
    if (event.shiftKey && (active === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  }

  /** If focus escapes the dialog (e.g. a click on the page behind), pull it back. */
  function keepFocusInside(event: FocusEvent) {
    if (closed || !modal) return;
    if (event.target instanceof Node && !host.contains(event.target)) {
      (root.querySelector<HTMLElement>("h2") ?? focusables()[0])?.focus();
    }
  }
  if (modal) document.addEventListener("focusin", keepFocusInside, true);

  // ---------------------------------------------------------------- rendering
  function button(label: string, kind: "primary" | "secondary" | "link", onClick: () => void, disabled = false) {
    return h("button", { type: "button", className: `uq-btn uq-${kind}`, onClick, disabled }, label);
  }

  function errorBox() {
    return inlineError ? h("p", { className: "uq-error", role: "alert" }, inlineError) : null;
  }

  function surveyView(): HTMLElement[] {
    const c = config!;
    const reason = selectedReason();
    const options_ = c.reasons.map((r) =>
      h(
        "label",
        { className: "uq-opt" },
        h("input", {
          type: "radio",
          name: "uq-reason",
          value: r.id,
          checked: r.id === reasonId,
          onChange: () => {
            reasonId = r.id;
            render(false);
            Array.from(root.querySelectorAll<HTMLInputElement>("input[type=radio]"))
              .find((input) => input.value === r.id)
              ?.focus();
          },
        }),
        h("span", {}, r.label),
      ),
    );
    const detailBox = reason?.freeText
      ? [
          h("label", { className: "uq-label", for: "uq-detail" }, "Tell us a bit more (optional)"),
          h("textarea", {
            id: "uq-detail",
            maxlength: MAX_DETAIL,
            onInput: (e: Event) => {
              detail = (e.target as HTMLTextAreaElement).value.slice(0, MAX_DETAIL);
            },
          }),
        ]
      : [];
    const textarea = detailBox[1] as HTMLTextAreaElement | undefined;
    if (textarea) textarea.value = detail;
    return [
      h("h2", { id: "uq-title", tabindex: "-1" }, "Before you go"),
      h("p", { id: "uq-desc" }, "We're sorry to see you leave. What's the main reason you're cancelling?"),
      h("fieldset", {}, h("legend", { className: "uq-sr" }, "Reason for cancelling"), ...options_),
      ...detailBox,
      h(
        "div",
        { className: "uq-actions" },
        button("Continue", "primary", submitSurvey, !reasonId),
        button("Never mind, keep my subscription", "link", close),
      ),
    ];
  }

  function offerView(offer: OfferView): HTMLElement[] {
    return [
      h("span", { className: "uq-badge" }, "A special offer for you"),
      h("h2", { id: "uq-title", tabindex: "-1" }, offerHeadline(offer)),
      h("p", { id: "uq-desc" }, offerBody(offer)),
      errorBox() as HTMLElement,
      h(
        "div",
        { className: "uq-actions" },
        button(acceptLabel(offer), "primary", () => void accept(offer)),
        button("No thanks, cancel", "link", () => void cancel({ name: "offer", offer })),
      ),
    ].filter(Boolean);
  }

  function confirmView(): HTMLElement[] {
    const c = config!;
    const when =
      c.cancelMode === "immediately"
        ? "Your subscription will end right away and you'll lose access."
        : c.periodEndsOn
          ? `Your subscription will end on ${c.periodEndsOn}. You keep access until then.`
          : "Your subscription will end at the close of your current billing period.";
    return [
      h("h2", { id: "uq-title", tabindex: "-1" }, "Cancel your subscription?"),
      h("p", { id: "uq-desc" }, when),
      errorBox() as HTMLElement,
      h(
        "div",
        { className: "uq-actions" },
        button("Keep my subscription", "primary", close),
        button("Cancel subscription", "secondary", () => void cancel({ name: "confirm" })),
      ),
    ].filter(Boolean);
  }

  function stepView(): HTMLElement[] {
    switch (step.name) {
      case "loading":
      case "working":
        return [
          h("h2", { id: "uq-title", tabindex: "-1", className: "uq-sr" }, step.name === "loading" ? "Loading" : step.text),
          h("div", { className: "uq-spinner", "aria-hidden": "true" }),
          h("p", { className: "uq-muted", style: "text-align:center", role: "status" }, step.name === "loading" ? "Loading…" : step.text),
        ];
      case "survey":
        return surveyView();
      case "offer":
        return offerView(step.offer);
      case "confirm":
        return confirmView();
      case "saved":
        return [
          h("span", { className: "uq-badge" }, "You're all set"),
          h("h2", { id: "uq-title", tabindex: "-1" }, "Thanks for staying!"),
          h("p", { id: "uq-desc" }, savedSummary(step.offer)),
          h("div", { className: "uq-actions" }, button("Done", "primary", close)),
        ];
      case "canceled": {
        const r = step.result;
        const text =
          r.mode === "immediately" || !r.endsOn
            ? "Your subscription has been cancelled. Thanks for giving us a try."
            : `Your subscription will end on ${r.endsOn}. You can keep using everything until then.`;
        return [
          h("h2", { id: "uq-title", tabindex: "-1" }, "Your subscription is cancelled"),
          h("p", { id: "uq-desc" }, text),
          h("div", { className: "uq-actions" }, button("Done", "primary", close)),
        ];
      }
      case "fatal":
        return [
          h("h2", { id: "uq-title", tabindex: "-1" }, "We couldn't load this"),
          h("p", { id: "uq-desc", role: "alert" }, step.message),
          h(
            "div",
            { className: "uq-actions" },
            button("Try again", "primary", () => void load()),
            button("Close", "secondary", close),
          ),
        ];
    }
  }

  function render(moveFocus = true) {
    if (closed) return;
    const busy = step.name === "loading" || step.name === "working";
    // In the inline preview, only move focus if the user is already working
    // inside it; never steal focus from the editor's own inputs.
    const focusInside = modal || shadow.activeElement !== null;
    const card = h(
      "div",
      {
        className: "uq-card",
        role: "dialog",
        "aria-modal": modal ? "true" : undefined,
        "aria-labelledby": "uq-title",
        "aria-describedby": busy ? undefined : "uq-desc",
        "aria-busy": busy ? "true" : undefined,
        onKeydown,
      },
      modal ? h("button", { type: "button", className: "uq-close", "aria-label": "Close", onClick: close }, "×") : null,
      ...stepView(),
      h("p", { className: "uq-foot" }, "Secured by unquit"),
    );
    const frame = h(
      "div",
      {
        className: modal ? "uq-overlay" : "uq-inline",
        onClick: modal
          ? (e: Event) => {
              if (e.target === e.currentTarget) close();
            }
          : undefined,
      },
      card,
    );
    root.replaceChildren(frame);
    if (moveFocus && focusInside) root.querySelector<HTMLElement>("h2")?.focus({ preventScroll: !modal });
  }

  void load();
  return { close };
}
