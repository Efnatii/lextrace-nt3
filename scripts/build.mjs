import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const dist = "dist";

const entryPoints = {
  "sw/worker": "src/sw/worker.js",
  "offscreen/offscreen": "src/offscreen/offscreen.js",
  "content/content": "src/content/content.js",
  "popup/popup": "src/popup/popup.js",
  "debug/debug": "src/debug/debug.js"
};

await mkdir(dist, { recursive: true });

await build({
  entryPoints,
  outdir: dist,
  bundle: true,
  format: "esm",
  target: ["chrome120"],
  sourcemap: true,
  logLevel: "info"
});

const staticFiles = [
  ["src/manifest.json", "manifest.json"],
  ["src/popup/popup.html", "popup/popup.html"],
  ["src/popup/popup.css", "popup/popup.css"],
  ["src/debug/debug.html", "debug/debug.html"],
  ["src/debug/debug.css", "debug/debug.css"],
  ["src/offscreen/offscreen.html", "offscreen/offscreen.html"],
  ["src/content/content.css", "content/content.css"]
];

for (const [from, to] of staticFiles) {
  const target = join(dist, to);
  await mkdir(dirname(target), { recursive: true });
  await cp(from, target);
}
