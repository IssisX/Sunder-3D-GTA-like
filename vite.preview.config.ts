import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Build config for the standalone single-file preview (`npm run preview:build`).
 *
 * Deliberately excludes TanStack Start, Nitro, auth and the database: the game
 * uses none of them, so the preview is the same game code with a bare mount
 * point instead of the app shell. Everything is inlined into one HTML file so
 * the result can be opened or shared with no server.
 */
export default defineConfig({
  root: fileURLToPath(new URL("./preview", import.meta.url)),
  base: "./",
  plugins: [viteReact(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-preview", import.meta.url)),
    emptyOutDir: true,
    // one chunk, one stylesheet: the inliner in scripts/build-preview.mjs folds
    // both into the HTML, and a code-split build would leave dangling fetches
    assetsInlineLimit: 1024 * 1024 * 8,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: "sunder.js",
        assetFileNames: "sunder[extname]",
      },
    },
  },
});
