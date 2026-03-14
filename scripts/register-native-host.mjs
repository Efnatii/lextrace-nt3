import { ensureDir, ensureExtensionKeyMetadata, getNativeHostExePath, paths, run, writeJson } from "./lib/common.mjs";

const extensionMetadata = await ensureExtensionKeyMetadata();
const nativeHostExe = getNativeHostExePath();

await ensureDir(paths.nativeHostManifestDir);

const nativeHostManifest = {
  name: "com.lextrace.nt3.host",
  description: "LexTrace NT3 native messaging host",
  path: nativeHostExe,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionMetadata.extensionId}/`]
};

await writeJson(paths.nativeHostManifest, nativeHostManifest);

await run("reg", [
  "add",
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.lextrace.nt3.host",
  "/ve",
  "/t",
  "REG_SZ",
  "/d",
  paths.nativeHostManifest,
  "/f"
]);

console.log(`Registered native host manifest at ${paths.nativeHostManifest}`);
