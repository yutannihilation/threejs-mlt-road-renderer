import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

/** The library build: `dist/index.js`, with the peers left to the host application. */
export default defineConfig({
  build: {
    target: "es2023",
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es"],
      fileName: "index",
    },
    rollupOptions: {
      external: ["three", "maplibre-gl", "@maplibre/mlt-wasm"],
    },
  },
});
