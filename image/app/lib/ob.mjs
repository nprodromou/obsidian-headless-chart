// The official Obsidian headless client ("ob").
//
// The client is not openly licensed, so the published image does not contain
// it. Instead the init container installs the version pinned in /app/ob's
// lockfile (npm verifies each package's integrity hash) onto the data volume,
// and skips the install on later starts while the pin is unchanged.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { run, firstLine } from './proc.mjs';

export const PIN_DIR = process.env.OB_PIN_DIR || '/app/ob';

export function clientDir(cfg) {
  return path.join(cfg.dataDir, '.ob');
}

export function obBin(cfg) {
  if (process.env.OB_BIN) return process.env.OB_BIN;
  const local = path.join(clientDir(cfg), 'node_modules', '.bin', 'ob');
  if (fs.existsSync(local)) return local;
  return 'ob';
}

// The install depends on the lockfile and, through better-sqlite3's native
// binding, on the Node ABI and CPU architecture.
export function installKey(pinDir = PIN_DIR) {
  const lock = fs.readFileSync(path.join(pinDir, 'package-lock.json'));
  const h = crypto.createHash('sha256').update(lock).digest('hex');
  return `${h} node-abi-${process.versions.modules} ${process.platform}-${process.arch}`;
}

export function installClient(cfg, { pinDir = PIN_DIR, log = () => {} } = {}) {
  const dir = clientDir(cfg);
  const marker = path.join(dir, '.installed');
  const key = installKey(pinDir);
  const bin = path.join(dir, 'node_modules', '.bin', 'ob');
  if (fs.existsSync(bin) && fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === key) {
    log('client already installed for this pin; skipping');
    return bin;
  }
  const tmp = `${dir}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(pinDir, f), path.join(tmp, f));
  }
  log(`installing the pinned client (${pinnedVersion(pinDir)}) from npm`);
  const res = run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=warn'], { cwd: tmp });
  if (!res.ok) {
    throw new Error(`npm ci failed (exit ${res.status}): ${res.stderr.trim().split('\n').slice(-5).join(' | ')}`);
  }
  fs.writeFileSync(path.join(tmp, '.installed'), key);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return bin;
}

export function pinnedVersion(pinDir = PIN_DIR) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pinDir, 'package.json'), 'utf8'));
  return `obsidian-headless@${pkg.dependencies['obsidian-headless']}`;
}

export function ob(cfg, args, opts = {}) {
  return run(obBin(cfg), args, opts);
}

export function obVersion(cfg) {
  const res = ob(cfg, ['--version']);
  if (!res.ok) throw new Error(`ob --version failed: ${firstLine(res.stderr || res.stdout) || res.error}`);
  return res.stdout.trim();
}
