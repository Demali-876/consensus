import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseManifest } from "./node/manifest";

interface ReleaseOptions {
  version?: string;
  commit?: string;
  downloadUrl?: string;
  outDir: string;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8")) as { version?: string };

  const version = options.version ?? process.env.CONSENSUS_NODE_VERSION ?? packageJson.version ?? "0.0.0";
  const commit = options.commit ?? process.env.CONSENSUS_NODE_COMMIT ?? await gitCommit();
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const artifactName = `consensus-node-${version}-${platformSlug()}.tgz`;
  const artifactPath = path.join(outDir, artifactName);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "consensus-node-release-"));

  try {
    const stageDir = path.join(tempDir, "consensus-node");
    await stagePackage(stageDir);
    await createTarball(stageDir, artifactPath);

    const sha256 = await fileSha256(artifactPath);
    process.env.CONSENSUS_NODE_VERSION = version;
    process.env.CONSENSUS_NODE_COMMIT = commit;
    process.env.CONSENSUS_NODE_TARBALL_SHA256 = `sha256:${sha256}`;
    if (options.downloadUrl) process.env.CONSENSUS_NODE_DOWNLOAD_URL = options.downloadUrl;

    const manifest = releaseManifest();
    const manifestPath = path.join(outDir, `consensus-node-${version}-${platformSlug()}.manifest.json`);
    const adminPayloadPath = path.join(outDir, `consensus-node-${version}-${platformSlug()}.admin-manifest.json`);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    await fs.writeFile(adminPayloadPath, JSON.stringify({ manifest, required: true }, null, 2), "utf8");

    console.log(JSON.stringify({
      artifact: artifactPath,
      manifest: manifestPath,
      admin_payload: adminPayloadPath,
      sha256: `sha256:${sha256}`,
      upload: "POST admin_payload to /admin/manifest with x-admin-key after hosting artifact at download_url",
    }, null, 2));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(args: string[]): ReleaseOptions {
  const options: ReleaseOptions = {
    outDir: "dist",
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--version" && next) {
      options.version = next;
      i += 1;
    } else if (arg === "--commit" && next) {
      options.commit = next;
      i += 1;
    } else if (arg === "--download-url" && next) {
      options.downloadUrl = next;
      i += 1;
    } else if (arg === "--out" && next) {
      options.outDir = next;
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete release option: ${arg}`);
    }
  }

  return options;
}

async function stagePackage(stageDir: string): Promise<void> {
  await fs.mkdir(stageDir, { recursive: true });
  for (const entry of ["src", "bin", "package.json", "tsconfig.json", "bun.lock", "README.md"]) {
    await fs.cp(path.join(rootDir, entry), path.join(stageDir, entry), {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`) &&
        !source.includes(`${path.sep}dist${path.sep}`),
    });
  }
}

async function createTarball(stageDir: string, artifactPath: string): Promise<void> {
  const proc = Bun.spawn(["tar", "-czf", artifactPath, "-C", path.dirname(stageDir), path.basename(stageDir)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`tar failed: ${stderr.trim()}`);
}

async function fileSha256(file: string): Promise<string> {
  const bytes = await fs.readFile(file);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function gitCommit(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: rootDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  if (exitCode !== 0) return "dev";
  return stdout.trim() || "dev";
}

function platformSlug(): string {
  return `${os.platform()}-${os.arch()}`;
}

main().catch((error) => {
  console.error("Release build failed:", error);
  process.exit(1);
});
