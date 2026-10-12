import type { Config } from "tailwindcss";

/** A colour backed by an "R G B" CSS variable, so `/50` opacity modifiers keep working. */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem", screens: { "2xl": "1200px" } },
    extend: {
      colors: {
        // One accent colour only. Everything else is white / zinc / near-black.
        brand: {
          DEFAULT: "#16A34A",
          dark: "#15803D",
          light: "#DCFCE7",
          glow: "#22C55E",
          soft: v("brand-soft"), // tinted surface, adapts to the theme
          text: v("brand-text"), // accessible green text on either theme
        },
        ink: "#0A0A0A",
        background: v("background"),
        foreground: v("foreground"),
        surface: v("surface"),
        card: { DEFAULT: v("card"), foreground: v("foreground") },
        popover: { DEFAULT: v("popover"), foreground: v("foreground") },
        muted: { DEFAULT: v("muted"), foreground: v("muted-foreground") },
        subtle: v("subtle-foreground"),
        border: v("border"),
        input: v("input"),
        ring: v("ring"),
        danger: { DEFAULT: v("danger"), soft: v("danger-soft") },
        warning: { DEFAULT: v("warning"), soft: v("warning-soft") },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"],
        mono: ["var(--font-geist-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        // A tight scale: small UI text, a few display sizes with negative tracking.
        "2xs": ["0.6875rem", { lineHeight: "1rem", letterSpacing: "0.01em" }],
        xs: ["0.75rem", { lineHeight: "1rem" }],
        sm: ["0.8125rem", { lineHeight: "1.25rem" }],
        base: ["0.9375rem", { lineHeight: "1.5rem" }],
        lg: ["1.0625rem", { lineHeight: "1.6rem", letterSpacing: "-0.01em" }],
        xl: ["1.25rem", { lineHeight: "1.75rem", letterSpacing: "-0.015em" }],
        "2xl": ["1.5rem", { lineHeight: "2rem", letterSpacing: "-0.02em" }],
        "3xl": ["1.875rem", { lineHeight: "2.25rem", letterSpacing: "-0.025em" }],
        "4xl": ["2.375rem", { lineHeight: "2.6rem", letterSpacing: "-0.03em" }],
        "5xl": ["3rem", { lineHeight: "1.05", letterSpacing: "-0.035em" }],
        "6xl": ["3.75rem", { lineHeight: "1.02", letterSpacing: "-0.04em" }],
        "7xl": ["4.5rem", { lineHeight: "1", letterSpacing: "-0.045em" }],
      },
      borderRadius: {
        lg: "0.625rem",
        xl: "0.875rem",
        "2xl": "1.125rem",
        "3xl": "1.5rem",
      },
      boxShadow: {
        xs: "0 1px 2px 0 rgb(0 0 0 / 0.04)",
        card: "0 1px 2px rgb(0 0 0 / 0.04), 0 1px 1px rgb(0 0 0 / 0.02)",
        lift: "0 1px 2px rgb(0 0 0 / 0.04), 0 12px 32px -12px rgb(0 0 0 / 0.18)",
        float: "0 2px 4px rgb(0 0 0 / 0.04), 0 24px 64px -16px rgb(0 0 0 / 0.28)",
        glow: "0 0 0 1px rgb(22 163 74 / 0.35), 0 8px 28px -6px rgb(34 197 94 / 0.55)",
        "glow-sm": "0 0 0 1px rgb(22 163 74 / 0.25), 0 4px 14px -4px rgb(34 197 94 / 0.45)",
        "inner-hi": "inset 0 1px 0 0 rgb(255 255 255 / 0.12)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "none" } },
        // Centred overlays keep their -50% translate while animating.
        "dialog-in": {
          from: { opacity: "0", transform: "translate(-50%, -48%) scale(.97)" },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" },
        },
        "palette-in": {
          from: { opacity: "0", transform: "translate(-50%, 8px) scale(.98)" },
          to: { opacity: "1", transform: "translate(-50%, 0) scale(1)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
        "grid-pan": { from: { backgroundPosition: "0 0" }, to: { backgroundPosition: "48px 48px" } },
        aurora: {
          "0%, 100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(4%, -3%, 0) scale(1.08)" },
        },
        "pulse-ring": { "0%": { transform: "scale(.9)", opacity: ".7" }, "100%": { transform: "scale(2.2)", opacity: "0" } },
        float: { "0%, 100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-8px)" } },
        "accordion-down": { from: { height: "0" }, to: { height: "var(--radix-accordion-content-height)" } },
        "accordion-up": { from: { height: "var(--radix-accordion-content-height)" }, to: { height: "0" } },
      },
      animation: {
        "fade-in": "fade-in .2s ease-out",
        "slide-up": "slide-up .25s cubic-bezier(.2,.8,.2,1)",
        "dialog-in": "dialog-in .28s cubic-bezier(.16,1,.3,1)",
        "palette-in": "palette-in .24s cubic-bezier(.16,1,.3,1)",
        shimmer: "shimmer 1.6s infinite",
        "grid-pan": "grid-pan 12s linear infinite",
        aurora: "aurora 18s ease-in-out infinite",
        "pulse-ring": "pulse-ring 1.8s cubic-bezier(.2,.8,.2,1) infinite",
        float: "float 6s ease-in-out infinite",
        "accordion-down": "accordion-down .22s cubic-bezier(.2,.8,.2,1)",
        "accordion-up": "accordion-up .18s ease-out",
      },
      transitionTimingFunction: { spring: "cubic-bezier(.2,.8,.2,1)" },
    },
  },
  plugins: [],
};

export default config;
