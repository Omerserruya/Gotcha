import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // gray-150 — used throughout the onboarding/business surfaces for a
        // border a hair softer than gray-200. Tailwind's default gray scale has
        // no 150, so without this the classes silently no-op (U-6). Merged into
        // the default gray palette (extend deep-merges), 50-900 preserved.
        gray: {
          150: "#eceef1",
        },
        primary: {
          50: "#f5f3ff",
          100: "#ede9fe",
          200: "#ddd6fe",
          300: "#c4b5fd",
          400: "#a78bfa",
          500: "#7c5cfc",
          600: "#6d4fe0",
          700: "#5b3dc4",
          800: "#4c3399",
          900: "#3b2880",
        },
      },
      boxShadow: {
        card: "0 2px 12px 0 rgba(124, 92, 252, 0.08)",
        float: "0 8px 30px rgba(0, 0, 0, 0.06)",
        subtle: "0 1px 3px rgba(0, 0, 0, 0.04)",
        panel: "0 1px 2px rgba(0, 0, 0, 0.03), 0 4px 16px rgba(0, 0, 0, 0.04)",
        "inner-glow": "inset 0 1px 0 rgba(255,255,255,0.8)",
      },
      // Onboarding motion language — one easing family, three entrances.
      keyframes: {
        riseIn: {
          "0%": { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        stageIn: {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        popIn: {
          "0%": { opacity: "0", transform: "scale(0.92)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        pulseSoft: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.65", transform: "scale(0.94)" },
        },
        // Directional movement transitions: forward exits up / enters from
        // below; back exits down / enters from above — the flow reads as one
        // continuous document scrolled in the direction of travel.
        riseDown: {
          "0%": { opacity: "0", transform: "translateY(-16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        leaveUp: {
          "0%": { opacity: "1", transform: "translateY(0)" },
          "100%": { opacity: "0", transform: "translateY(-12px)" },
        },
        leaveDown: {
          "0%": { opacity: "1", transform: "translateY(0)" },
          "100%": { opacity: "0", transform: "translateY(12px)" },
        },
      },
      animation: {
        riseIn: "riseIn 0.55s cubic-bezier(0.16, 1, 0.3, 1) both",
        stageIn: "stageIn 0.45s cubic-bezier(0.16, 1, 0.3, 1) both",
        popIn: "popIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both",
        pulseSoft: "pulseSoft 1.6s ease-in-out infinite",
        riseDown: "riseDown 0.55s cubic-bezier(0.16, 1, 0.3, 1) both",
        leaveUp: "leaveUp 0.16s ease-in both",
        leaveDown: "leaveDown 0.16s ease-in both",
      },
    },
  },
  plugins: [typography],
};

export default config;
