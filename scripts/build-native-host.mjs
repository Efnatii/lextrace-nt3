import { cleanDir, paths, run } from "./lib/common.mjs";

await cleanDir(paths.nativeHostPublish);

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

