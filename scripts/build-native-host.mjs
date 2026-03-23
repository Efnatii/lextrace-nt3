import path from "node:path";

import { cleanDir, paths, run, writeNativeHostPublishPath } from "./lib/common.mjs";

const publishDir = path.join(paths.nativeHostBuilds, `${Date.now()}`);

await cleanDir(publishDir);

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
    publishDir
  ]
);

await writeNativeHostPublishPath(publishDir);

console.log(`Published native host to ${publishDir}`);
