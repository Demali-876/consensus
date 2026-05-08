import fs   from 'fs';
import path from 'path';
import os   from 'os';


function fontDirs(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        path.join(os.homedir(), 'Library/Fonts'),
        '/Library/Fonts',
        '/System/Library/Fonts/Supplemental',
      ];
    case 'linux':
      return [
        path.join(os.homedir(), '.local/share/fonts'),
        '/usr/share/fonts',
        '/usr/local/share/fonts',
      ];
    case 'win32':
      return [
        path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'),
        path.join(os.homedir(), 'AppData/Local/Microsoft/Windows/Fonts'),
      ];
    default:
      return [];
  }
}

function scanDir(dir: string, depth = 2): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (/jetbrains.?mono/i.test(entry.name)) return true;
      if (depth > 0 && entry.isDirectory()) {
        if (scanDir(path.join(dir, entry.name), depth - 1)) return true;
      }
    }
  } catch { /* dir inaccessible */ }
  return false;
}

export function isJetBrainsMonoInstalled(): boolean {
  return fontDirs().some(d => scanDir(d));
}


function installFontDir(): string {
  switch (process.platform) {
    case 'darwin': return path.join(os.homedir(), 'Library/Fonts');
    case 'linux':  return path.join(os.homedir(), '.local/share/fonts');
    case 'win32':  return path.join(os.homedir(), 'AppData/Local/Microsoft/Windows/Fonts');
    default:       return path.join(os.homedir(), '.fonts');
  }
}

function* walkTtf(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTtf(full);
    else if (entry.name.toLowerCase().endsWith('.ttf')) yield full;
  }
}

async function doInstall(): Promise<void> {
  const apiRes = await fetch(
    'https://api.github.com/repos/JetBrains/JetBrainsMono/releases/latest',
    { headers: { 'User-Agent': 'consensus-cli' }, signal: AbortSignal.timeout(10_000) },
  );
  if (!apiRes.ok) return;

  const release = await apiRes.json() as {
    assets: { name: string; browser_download_url: string }[];
  };
  const asset = release.assets.find(a => a.name.endsWith('.zip'));
  if (!asset) return;

  const dlRes = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(60_000) });
  if (!dlRes.ok) return;

  const buf    = Buffer.from(await dlRes.arrayBuffer());
  const tmpDir = os.tmpdir();
  const zipPath = path.join(tmpDir, asset.name);
  const outDir  = path.join(tmpDir, 'consensus-jbmono');

  fs.writeFileSync(zipPath, buf);
  fs.mkdirSync(outDir, { recursive: true });

  const extractCmd = process.platform === 'darwin'
    ? ['ditto', '-xk', zipPath, outDir]
    : ['unzip', '-o', '-q', zipPath, '-d', outDir];

  const proc = Bun.spawnSync(extractCmd, { stderr: 'pipe' });
  if (proc.exitCode !== 0) return;

  const fontDir = installFontDir();
  fs.mkdirSync(fontDir, { recursive: true });
  for (const ttf of walkTtf(outDir)) {
    fs.copyFileSync(ttf, path.join(fontDir, path.basename(ttf)));
  }

  if (process.platform === 'linux') {
    Bun.spawnSync(['fc-cache', '-f', fontDir]);
  }

  try {
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(outDir,  { recursive: true, force: true });
  } catch { /* non-fatal */ }
}

export function ensureJetBrainsMono(): void {
  if (isJetBrainsMonoInstalled()) return;
  void doInstall().catch(() => { /* non-fatal — best effort */ });
}
