import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
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
    },
  },
  plugins: [typography],
};

export default config;
