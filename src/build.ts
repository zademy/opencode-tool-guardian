/**
 * Bundles the plugin into a single ESM file so OpenCode can load it from a plain
 * directory without resolving node_modules at runtime.
 */
import { rmSync } from "node:fs";
import { build } from "bun";

rmSync("dist", { recursive: true, force: true });

const result = await build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  minify: false,
  sourcemap: "none",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("built dist/index.js");
