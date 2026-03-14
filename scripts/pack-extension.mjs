import { createRequire } from "node:module";
import path from "node:path";

import { cleanDir, ensureExtensionKeyMetadata, paths } from "./lib/common.mjs";

const require = createRequire(import.meta.url);
const crx3 = require("crx3");

await ensureExtensionKeyMetadata();
await cleanDir(paths.packagedDir);

await crx3([path.join(paths.extensionDist, "manifest.json")], {
  keyPath: paths.extensionKey,
  crxPath: paths.packagedCrx,
  zipPath: paths.packagedZip
});

console.log(`Packed CRX to ${paths.packagedCrx}`);

