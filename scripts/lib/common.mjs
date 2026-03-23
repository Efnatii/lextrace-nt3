import { existsSync, promises as fs, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

export const paths = {
  root: path.resolve(currentDir, "..", ".."),
  artifacts: path.resolve(currentDir, "..", "..", "artifacts"),
  dist: path.resolve(currentDir, "..", "..", "artifacts", "dist"),
  extensionRoot: path.resolve(currentDir, "..", "..", "extension"),
  extensionPublic: path.resolve(currentDir, "..", "..", "extension", "public"),
  extensionSource: path.resolve(currentDir, "..", "..", "extension", "src"),
  extensionDist: path.resolve(currentDir, "..", "..", "artifacts", "dist", "extension"),
  extensionKey: path.resolve(currentDir, "..", "..", "artifacts", "extension", "lextrace-dev-key.pem"),
  extensionMetadata: path.resolve(currentDir, "..", "..", "artifacts", "extension", "metadata.json"),
  packagedDir: path.resolve(currentDir, "..", "..", "artifacts", "packaged"),
  packagedCrx: path.resolve(currentDir, "..", "..", "artifacts", "packaged", "lextrace-nt3.crx"),
  packagedZip: path.resolve(currentDir, "..", "..", "artifacts", "packaged", "lextrace-nt3.zip"),
  nativeHostProject: path.resolve(currentDir, "..", "..", "native-host", "LexTrace.NativeHost"),
  nativeHostPublish: path.resolve(currentDir, "..", "..", "artifacts", "native-host", "publish"),
  nativeHostBuilds: path.resolve(currentDir, "..", "..", "artifacts", "native-host", "builds"),
  nativeHostPublishInfo: path.resolve(currentDir, "..", "..", "artifacts", "native-host", "publish-info.json"),
  nativeHostManifestDir: path.resolve(currentDir, "..", "..", "artifacts", "native-host", "manifests"),
  nativeHostManifest: path.resolve(currentDir, "..", "..", "artifacts", "native-host", "manifests", "com.lextrace.nt3.host.json"),
  tmp: path.resolve(currentDir, "..", "..", "artifacts", "tmp"),
  edgeProfile: path.resolve(currentDir, "..", "..", "artifacts", "tmp", "edge-profile"),
  edgeUserData: path.resolve(currentDir, "..", "..", "artifacts", "tmp", "edge-user-data")
};

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function cleanDir(targetPath) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      break;
    } catch (error) {
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code) || attempt === 4) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }

  await fs.mkdir(targetPath, { recursive: true });
}

export async function copyDir(source, destination) {
  await fs.cp(source, destination, { recursive: true });
}

export async function readJson(targetPath) {
  return JSON.parse(await fs.readFile(targetPath, "utf8"));
}

export async function writeJson(targetPath, value) {
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readPackageJson() {
  return readJson(path.join(paths.root, "package.json"));
}

export function getNativeHostPublishPath() {
  if (existsSync(paths.nativeHostPublishInfo)) {
    try {
      const metadata = JSON.parse(readFileSync(paths.nativeHostPublishInfo, "utf8"));
      if (typeof metadata?.publishPath === "string" && metadata.publishPath.length > 0) {
        return metadata.publishPath;
      }
    } catch {
      // Fall back to the legacy path if the metadata file is unreadable.
    }
  }

  return paths.nativeHostPublish;
}

export async function fileExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureExtensionKeyMetadata() {
  await ensureDir(path.dirname(paths.extensionKey));
  if (!(await fileExists(paths.extensionKey))) {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem"
      },
      publicKeyEncoding: {
        type: "spki",
        format: "pem"
      }
    });

    await fs.writeFile(paths.extensionKey, privateKey, "utf8");
  }

  const privateKeyPem = await fs.readFile(paths.extensionKey, "utf8");
  const publicKeyDer = createPublicKey(createPrivateKey(privateKeyPem)).export({
    type: "spki",
    format: "der"
  });

  const manifestKey = Buffer.from(publicKeyDer).toString("base64");
  const extensionId = computeExtensionId(manifestKey);
  const metadata = {
    extensionId,
    manifestKey,
    privateKeyPath: paths.extensionKey
  };

  await writeJson(paths.extensionMetadata, metadata);
  return metadata;
}

export function computeExtensionId(manifestKey) {
  const digest = createHash("sha256")
    .update(Buffer.from(manifestKey, "base64"))
    .digest("hex")
    .slice(0, 32);

  return [...digest]
    .map((character) => String.fromCharCode(97 + Number.parseInt(character, 16)))
    .join("");
}

export async function run(command, args, options = {}) {
  await ensureDir(options.cwd ?? paths.root);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? paths.root,
      stdio: options.stdio ?? "inherit",
      shell: options.shell ?? false,
      env: {
        ...process.env,
        ...(options.env ?? {})
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
    });
  });
}

export function getNativeHostExePath() {
  return path.join(getNativeHostPublishPath(), "LexTrace.NativeHost.exe");
}

export async function writeNativeHostPublishPath(publishPath) {
  await writeJson(paths.nativeHostPublishInfo, { publishPath });
}

