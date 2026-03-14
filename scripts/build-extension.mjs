import { promises as fs } from "node:fs";
import path from "node:path";

import esbuild from "esbuild";

import { cleanDir, copyDir, ensureDir, ensureExtensionKeyMetadata, paths, readPackageJson, writeJson } from "./lib/common.mjs";

const packageJson = await readPackageJson();
const extensionMetadata = await ensureExtensionKeyMetadata();

await cleanDir(paths.extensionDist);
await ensureDir(paths.extensionDist);
await copyDir(paths.extensionPublic, paths.extensionDist);

const buildCommon = {
  bundle: true,
  minify: false,
  sourcemap: "inline",
  target: ["edge145"],
  platform: "browser",
  legalComments: "none"
};

await esbuild.build({
  ...buildCommon,
  entryPoints: [path.join(paths.extensionSource, "background", "index.ts")],
  format: "esm",
  outfile: path.join(paths.extensionDist, "background.js")
});

await esbuild.build({
  ...buildCommon,
  entryPoints: [path.join(paths.extensionSource, "popup", "index.ts")],
  format: "esm",
  outfile: path.join(paths.extensionDist, "popup.js")
});

await esbuild.build({
  ...buildCommon,
  entryPoints: [path.join(paths.extensionSource, "content", "index.ts")],
  format: "iife",
  outfile: path.join(paths.extensionDist, "content.js")
});

const manifest = {
  manifest_version: 3,
  name: "LexTrace NT3",
  version: packageJson.version,
  description: packageJson.description,
  key: extensionMetadata.manifestKey,
  permissions: ["storage", "nativeMessaging", "tabs", "alarms", "scripting"],
  host_permissions: ["http://*/*", "https://*/*"],
  background: {
    service_worker: "background.js",
    type: "module"
  },
  action: {
    default_popup: "popup.html"
  },
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["content.js"],
      run_at: "document_idle"
    }
  ]
};

await writeJson(path.join(paths.extensionDist, "manifest.json"), manifest);
await fs.writeFile(
  path.join(paths.extensionDist, "extension-metadata.json"),
  `${JSON.stringify(extensionMetadata, null, 2)}\n`,
  "utf8"
);

console.log(`Built extension to ${paths.extensionDist}`);
console.log(`Extension ID: ${extensionMetadata.extensionId}`);
