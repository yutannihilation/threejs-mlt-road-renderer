import { cpSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite-plus";

/**
 * Serve the tiles in `./data` at `tiles/{z}/{x}/{y}.mlt` under the base in development, and copy
 * them there into builds. A tile that does not exist is a 404, which the layer reads as empty.
 */
function serveTiles(dir: string): Plugin {
  return {
    name: "serve-tiles",
    writeBundle(options) {
      if (options.dir) cpSync(dir, resolve(options.dir, "tiles"), { recursive: true });
    },
    configureServer(server) {
      server.middlewares.use("/tiles", (req, res, next) => {
        const match = /^\/(\d+)\/(\d+)\/(\d+)\.mlt$/.exec(req.url ?? "");
        if (!match) return next();
        const path = resolve(dir, match[1], match[2], `${match[3]}.mlt`);
        if (!existsSync(path)) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(readFileSync(path));
      });
    },
  };
}

export default defineConfig({
  // A missing tile must be a 404, not the SPA's index.html.
  appType: "mpa",
  plugins: [serveTiles(resolve(import.meta.dirname, "data"))],
  // Pre-bundling breaks the package's `import * as wasm from "./mlt_wasm_bg.wasm"`.
  optimizeDeps: { exclude: ["@maplibre/mlt-wasm"] },
  build: {
    target: "es2023",
    outDir: "dist-demo",
  },
  test: {
    // Its dist/ imports siblings without file extensions, which Node's ESM loader rejects; let Vite resolve them.
    server: { deps: { inline: ["@maplibre/mlt-wasm"] } },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["data/**"],
  },
  lint: {
    ignorePatterns: ["data/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
