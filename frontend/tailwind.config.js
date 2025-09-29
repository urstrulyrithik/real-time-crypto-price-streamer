// tailwind.config.js gist:
// - Scans pages/components/app for class names (Next.js app/router friendly).
// - Extends theme with a subtle "blink" keyframe/animation for price change flashes.
// - No extra plugins enabled; base Tailwind utilities + our custom animation.

 /** @type {import('tailwindcss').Config} */
 module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      keyframes: {
        blink: {
          '0%': { backgroundColor: '#4a5568' }, // brighter gray flash
          '100%': { backgroundColor: 'transparent' },
        },
      },
      animation: {
        blink: 'blink 0.6s ease-in-out',
      },
    },
  },
  plugins: [],
};

