import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // One accent colour only. Everything else is white / near-black / greys.
        brand: {
          DEFAULT: "#16A34A",
          dark: "#15803D",
          light: "#DCFCE7",
        },
        ink: "#0A0A0A",
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
