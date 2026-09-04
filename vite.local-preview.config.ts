import path from "node:path";
import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: path.resolve(process.cwd(), "local-preview"),
  base: "./",
  resolve: {
    alias: {
      "@": path.resolve(process.cwd(), "src"),
    },
  },
  plugins: [tailwindcss(), viteReact()],
  build: {
    outDir: path.resolve(process.cwd(), "local-preview-dist"),
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: "sunder.js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
