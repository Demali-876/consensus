#!/usr/bin/env npx tsx

/**
 * Generate a signed version manifest for a Consensus Network release.
 *
 * Usage:
 *   npx tsx scripts/generate-manifest.ts \
 *     --version 0.1.1 \
 *     --signing-key ./manifest-signing.key \
 *     --github-url https://github.com/.../releases/tag/v0.1.1 \
 *     --asset darwin-arm64=./release-darwin-arm64.tar.gz \
 *     --asset linux-x64=./release-linux-x64.tar.gz \
 *     --output ./manifests/0.1.1.json
 *
 * Key setup (one-time):
 *   openssl genpkey -algorithm ED25519 -out manifest-signing.key
 *   openssl pkey -in manifest-signing.key -pubout -out manifest-signing.pub
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

interface AssetInput {
  platform: string;
  filePath: string;
}

interface ManifestAsset {
  platform: string;
  url: string;
  sha256: string;
}

interface Manifest {
  version: string;
  released_at: string;
  github_release_url: string;
  assets: ManifestAsset[];
  signature?: string;
}

interface ParsedArgs {
  version: string | null;
  signingKey: string | null;
  githubUrl: string | null;
  assets: AssetInput[];
  output: string | null;
  uploadTo: string | null;
  adminKey: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    version: null,
    signingKey: null,
    githubUrl: null,
    assets: [],
    output: null,
    uploadTo: null,
    adminKey: null,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--version":
        args.version = argv[++i];
        break;
      case "--signing-key":
        args.signingKey = argv[++i];
        break;
      case "--github-url":
        args.githubUrl = argv[++i];
        break;
      case "--asset": {
        const val = argv[++i];
        const eqIdx = val.indexOf("=");
        if (eqIdx === -1) {
          console.error(`Invalid --asset format: "${val}". Expected: platform=filepath`);
          process.exit(1);
        }
        args.assets.push({
          platform: val.slice(0, eqIdx),
          filePath: val.slice(eqIdx + 1),
        });
        break;
      }
      case "--output":
        args.output = argv[++i];
        break;
      case "--upload-to":
        args.uploadTo = argv[++i];
        break;
      case "--admin-key":
        args.adminKey = argv[++i];
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        console.error(`Unknown flag: ${argv[i]}`);
        printUsage();
        process.exit(1);
    }
  }
  return args;
}

function printUsage(): void {
  console.log(`
Usage: npx tsx scripts/generate-manifest.ts [options]

Required:
  --version <version>       Release version (e.g., 0.1.1)
  --signing-key <path>      Ed25519 private key PEM file
  --asset <platform>=<file> Release asset (repeatable)

Optional:
  --github-url <url>        GitHub release URL
  --output <path>           Output manifest JSON file (default: stdout)
  --upload-to <url>         POST manifest to server's /admin/manifest endpoint
  --admin-key <key>         Admin key for --upload-to
  `);
}

function hashFile(filePath: string): string {
  const data = fs.readFileSync(filePath);
  const hash = crypto.createHash("sha256").update(data).digest("hex");
  return `sha256:${hash}`;
}

function main(): void {
  const args = parseArgs(process.argv);

  if (!args.version) {
    console.error("Error: --version is required");
    process.exit(1);
  }
  if (!args.signingKey) {
    console.error("Error: --signing-key is required");
    process.exit(1);
  }
  if (args.assets.length === 0) {
    console.error("Error: at least one --asset is required");
    process.exit(1);
  }

  // Load signing key
  const signingKeyPem = fs.readFileSync(args.signingKey, "utf8");
  const signingKey = crypto.createPrivateKey(signingKeyPem);

  // Verify it's Ed25519
  if (signingKey.asymmetricKeyType !== "ed25519") {
    console.error(`Error: signing key must be Ed25519, got ${signingKey.asymmetricKeyType}`);
    process.exit(1);
  }

  // Hash each asset
  const assets: ManifestAsset[] = args.assets.map(({ platform, filePath }) => {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`Error: asset file not found: ${resolvedPath}`);
      process.exit(1);
    }

    const sha256 = hashFile(resolvedPath);
    console.error(`  ${platform}: ${sha256} (${resolvedPath})`);

    return {
      platform,
      url: args.githubUrl
        ? `${args.githubUrl.replace(/\/tag\//, "/download/")}/consensus-node-${platform}.tar.gz`
        : `file://${resolvedPath}`,
      sha256,
    };
  });

  // Build manifest (without signature)
  const manifest: Manifest = {
    version: args.version,
    released_at: new Date().toISOString(),
    github_release_url: args.githubUrl || "",
    assets,
  };

  // Canonicalize for signing: sorted keys, no signature field
  const manifestRecord = manifest as unknown as Record<string, unknown>;
  const sortedKeys = Object.keys(manifestRecord).sort();
  const sorted: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    sorted[key] = manifestRecord[key];
  }
  const canonical = JSON.stringify(sorted);

  // Sign with Ed25519
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), signingKey);
  manifest.signature = signature.toString("base64");

  const output = JSON.stringify(manifest, null, 2);

  // Output
  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, output, "utf8");
    console.error(`Manifest written to: ${args.output}`);
  } else {
    console.log(output);
  }

  // Optionally upload to server
  if (args.uploadTo) {
    if (!args.adminKey) {
      console.error("Error: --admin-key is required when using --upload-to");
      process.exit(1);
    }

    console.error(`Uploading to ${args.uploadTo}/admin/manifest...`);
    fetch(`${args.uploadTo}/admin/manifest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": args.adminKey,
      },
      body: JSON.stringify({
        manifest: { ...manifest, signature: undefined },
        signature: manifest.signature,
        required: true,
      }),
    })
      .then(async (res) => {
        const body = await res.json();
        if (res.ok) {
          console.error("Upload successful:", body);
        } else {
          console.error("Upload failed:", res.status, body);
          process.exit(1);
        }
      })
      .catch((err: Error) => {
        console.error("Upload error:", err.message);
        process.exit(1);
      });
  }
}

main();
