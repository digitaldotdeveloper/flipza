import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  // Relative, so a built page works from a subdirectory or straight off disk.
  base: './',
  plugins: [react()],
  build:
    mode === 'standalone'
      ? {
          outDir: 'dist-standalone',
          // Everything gets inlined into one HTML file by
          // scripts/build-standalone.mjs, and a `<script type="module">` cannot
          // be loaded over file:// - so the bundle has to be a classic script.
          rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } },
          cssCodeSplit: false,
          modulePreload: { polyfill: false },
        }
      : {},
}))
