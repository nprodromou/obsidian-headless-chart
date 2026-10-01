#!/usr/bin/env node
// Sync container: supervises `ob sync --continuous` for one vault.
//
// Output passes through to stdout with a vault prefix. Each line refreshes a
// status file in the shared status volume; its mtime is the liveness heartbeat
// and its contents feed the keeper's metrics. When ob exits, this exits with
// the same code and Kubernetes restarts the container.
//
//   sync.mjs <vault-name>

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { loadConfig, findVault } from '../lib/config.mjs';
import { obBin } from '../lib/ob.mjs';
import { syncStatusPath, writeSyncStatus, FULLY_SYNCED } from '../lib/syncstatus.mjs';
import { fail } from '../lib/log.mjs';

const WRITE_EVERY_MS = 5000;

const name = process.argv[2];
if (!name) fail('sync', 'usage: sync.mjs <vault-name>', 2);

let cfg;
let vault;
try {
  cfg = loadConfig();
  vault = findVault(cfg, name);
} catch (err) {
  fail(`sync:${name}`, err.message);
}

const file = syncStatusPath(cfg, name);
const now = () => Math.floor(Date.now() / 1000);
const status = { vault: name, startedAt: now(), lastOutputAt: now(), lastFullySyncedAt: 0, lastLine: '' };
writeSyncStatus(file, status);

let pending = null;
function scheduleWrite() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    writeSyncStatus(file, status);
  }, WRITE_EVERY_MS);
}

const child = spawn(obBin(cfg), ['sync', '--continuous', '--path', vault.dir], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

function onLine(stream) {
  return (line) => {
    stream.write(`[${name}] ${line}\n`);
    status.lastOutputAt = now();
    status.lastLine = line.slice(0, 500);
    if (FULLY_SYNCED.test(line)) status.lastFullySyncedAt = status.lastOutputAt;
    scheduleWrite();
  };
}
readline.createInterface({ input: child.stdout }).on('line', onLine(process.stdout));
readline.createInterface({ input: child.stderr }).on('line', onLine(process.stderr));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => child.kill(sig));
}

child.on('error', (err) => fail(`sync:${name}`, `could not start ob: ${err.message}`));
child.on('exit', (code, signal) => {
  if (pending) clearTimeout(pending);
  writeSyncStatus(file, status);
  process.stderr.write(`[${name}] ob exited (${signal || `code ${code}`})\n`);
  process.exit(code ?? 1);
});
