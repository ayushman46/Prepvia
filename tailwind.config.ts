import type { Config } from "tailwindcss";

// Hex values (mirrored as CSS variables in globals.css) so Tailwind opacity
// modifiers such as `text-vast/70` and `bg-cream/90` generate real CSS.
const config: Config = {
  content: ["./src/components/**/*.{js,ts,jsx,tsx,mdx}", "./src/app/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        lavender: "#f0d7ff",
        forest: "#034f46",
        ember: "#ffa946",
        vast: "#1a1a1a",
        cream: "#ffffeb",
        stone: "#e4e4d0",
        fog: "#8a8a80",
        charcoal: "#222222",
      },
      fontFamily: {
        serif: ["var(--font-eb-garamond)", "Georgia", "serif"],
        sans: ["var(--font-figtree)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
