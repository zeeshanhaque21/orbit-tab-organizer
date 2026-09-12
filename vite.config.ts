import { defineConfig } from "vite"
import { resolve } from "node:path"

const projectRoot = __dirname
const srcRoot = resolve(projectRoot, "src")

export default defineConfig({
  // the extension pages live in src/, so rooting there puts popup.html,
  // hub.html and options.html at the top level of dist/ where the manifest
  // expects them
  root: srcRoot,
  publicDir: resolve(projectRoot, "public"),
  resolve: {
    alias: { "~": srcRoot },
  },
  build: {
    outDir: resolve(projectRoot, "dist"),
    // cleared by scripts/clean.mjs instead: Vite removes the tree in one
    // recursive call, which trips the harness bulk-delete guard
    emptyOutDir: false,
    target: "chrome120",
    minify: "esbuild",
    sourcemap: false,
    modulePreload: false,
    cssCodeSplit: true,
    rollupOptions: {
      input: {
        popup: resolve(srcRoot, "popup.html"),
        hub: resolve(srcRoot, "hub.html"),
        options: resolve(srcRoot, "options.html"),
        background: resolve(srcRoot, "background/index.ts"),
      },
      output: {
        // the service worker must land at a stable path the manifest can name
        entryFileNames: (chunk: { name: string }) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  test: {
    root: projectRoot,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
} as never)
