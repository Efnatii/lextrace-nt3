import { cleanDir, paths, run } from "./lib/common.mjs";

await cleanPublishDir();

await run(
  "dotnet",
  [
    "publish",
    paths.nativeHostProject,
    "-c",
    "Debug",
    "-r",
    "win-x64",
    "--self-contained",
    "false",
    "-o",
    paths.nativeHostPublish
  ]
);

console.log(`Published native host to ${paths.nativeHostPublish}`);

async function cleanPublishDir() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await cleanDir(paths.nativeHostPublish);
      return;
    } catch (error) {
      if (error?.code !== "EBUSY") {
        throw error;
      }

      await stopRunningNativeHost();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  await cleanDir(paths.nativeHostPublish);
}

async function stopRunningNativeHost() {
  try {
    await run("taskkill", ["/IM", "LexTrace.NativeHost.exe", "/F", "/T"]);
  } catch {
    // Best effort only.
  }
}
