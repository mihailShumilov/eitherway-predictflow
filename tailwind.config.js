/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: 'rgb(var(--terminal-bg) / <alpha-value>)',
          surface: 'rgb(var(--terminal-surface) / <alpha-value>)',
          card: 'rgb(var(--terminal-card) / <alpha-value>)',
          border: 'rgb(var(--terminal-border) / <alpha-value>)',
          highlight: 'rgb(var(--terminal-highlight) / <alpha-value>)',
          text: 'rgb(var(--terminal-text) / <alpha-value>)',
          muted: 'rgb(var(--terminal-muted) / <alpha-value>)',
          accent: 'rgb(var(--terminal-accent) / <alpha-value>)',
          green: 'rgb(var(--terminal-green) / <alpha-value>)',
          red: 'rgb(var(--terminal-red) / <alpha-value>)',
          yellow: 'rgb(var(--terminal-yellow) / <alpha-value>)',
          cyan: 'rgb(var(--terminal-cyan) / <alpha-value>)',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        sans: ['"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-600px 0' },
          '100%': { backgroundPosition: '600px 0' },
        },
        'flash-green': {
          '0%': { backgroundColor: 'rgba(16, 185, 129, 0.35)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'flash-red': {
          '0%': { backgroundColor: 'rgba(239, 68, 68, 0.35)' },
          '100%': { backgroundColor: 'transparent' },
        },
        'slide-in': {
          '0%': { transform: 'translateX(16px)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
      animation: {
        shimmer: 'shimmer 1.4s infinite linear',
        'flash-green': 'flash-green 500ms ease-out',
        'flash-red': 'flash-red 500ms ease-out',
        'slide-in': 'slide-in 200ms ease-out',
      },
    },
  },
  plugins: [],
}
