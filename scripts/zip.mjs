import { access, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const distPath = path.join(process.cwd(), "dist");
const outDir = path.join(process.cwd(), "artifacts");
const zipPath = path.join(outDir, "neuro-translate.zip");

await access(distPath);
await mkdir(outDir, { recursive: true });
await rm(zipPath, { force: true });

await execFileAsync("tar", ["-a", "-c", "-f", zipPath, "-C", distPath, "."]);
console.log(`Created: ${zipPath}`);