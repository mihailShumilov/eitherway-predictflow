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
          bg: '#080c16',
          surface: '#0f1423',
          card: '#141a2e',
          border: '#1e2740',
          highlight: '#1c2544',
          text: '#e2e8f0',
          muted: '#64748b',
          accent: '#3b82f6',
          green: '#10b981',
          red: '#ef4444',
          yellow: '#f59e0b',
          cyan: '#06b6d4',
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
