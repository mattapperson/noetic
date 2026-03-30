/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './src/client/**/*.{js,ts,jsx,tsx}',
    './src/client/index.html',
  ],
  theme: {
    extend: {
      colors: {
        noetic: {
          bg: 'var(--noetic-bg)',
          'canvas-bg': 'var(--noetic-canvas-bg)',
          'sidebar-bg': 'var(--noetic-sidebar-bg)',
          'node-bg': 'var(--noetic-node-bg)',
          border: 'var(--noetic-border)',
          text: 'var(--noetic-text)',
          'text-secondary': 'var(--noetic-text-secondary)',
          'text-muted': 'var(--noetic-text-muted)',
          accent: 'var(--noetic-accent)',
          'input-bg': 'var(--noetic-input-bg)',
          'button-bg': 'var(--noetic-button-bg)',
          'button-hover': 'var(--noetic-button-hover)',
          hover: 'var(--noetic-hover)',
          llm: 'var(--noetic-llm-color)',
          tool: 'var(--noetic-tool-color)',
          run: 'var(--noetic-run-color)',
          branch: 'var(--noetic-branch-color)',
          fork: 'var(--noetic-fork-color)',
          spawn: 'var(--noetic-spawn-color)',
          loop: 'var(--noetic-loop-color)',
        },
      },
    },
  },
  plugins: [],
};
