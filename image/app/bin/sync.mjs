#!/usr/bin/env node
// Sync container: supervises `ob sync --continuous` for one vault.
//
// Output passes through to stdout with a vault prefix. Each line refreshes a
// status file in the shared status volume; its mtime is the liveness heartbeat
// and its contents feed the keeper's metrics. When ob exits, this exits with
// the same code and Kubernetes restarts the container.
//
// Before starting the client it waits for the vault to be linked, polling
// `ob sync-status` every 10 seconds. In Secret mode the init container has
// already linked it and the first poll passes. In wizard mode a vault can be
// unlinked until someone links it from the setup page; `ob sync` would exit 3
// on it and the container would crash-loop. While waiting, the status file is
// rewritten on every poll (the liveness heartbeat) with waiting: "not-linked".
//
//   sync.mjs <vault-name>

import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { loadConfig, findVault } from '../lib/config.mjs';
import { obBin } from '../lib/ob.mjs';
import { runAsync, firstLine } from '../lib/proc.mjs';
import { syncStatusPath, writeSyncStatus, FULLY_SYNCED } from '../lib/syncstatus.mjs';
import { log, fail } from '../lib/log.mjs';

const WRITE_EVERY_MS = 5000;
// Overridable so tests don't wait 10 seconds per poll.
const LINK_POLL_MS = Number(process.env.OHS_LINK_POLL_MS) || 10000;

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
// Written by the first link poll, not before, so the file never claims a
// vault is linked before anything has checked.
const status = { vault: name, startedAt: now(), lastOutputAt: now(), lastFullySyncedAt: 0, lastLine: '' };

let pending = null;
function scheduleWrite() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    writeSyncStatus(file, status);
  }, WRITE_EVERY_MS);
}

let child = null;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => (child ? child.kill(sig) : process.exit(0)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForLink() {
  let said = '';
  for (;;) {
    const res = await runAsync(obBin(cfg), ['sync-status', '--path', vault.dir, '--json'], { timeoutMs: 60000 });
    if (res.ok) {
      if (said) log(`sync:${name}`, 'linked; starting the client');
      return;
    }
    const why = firstLine(res.stderr) || (res.timedOut ? 'ob sync-status timed out' : `ob sync-status exit ${res.status}`);
    status.waiting = 'not-linked';
    status.lastLine = `waiting for this vault to be linked: ${why}`.slice(0, 500);
    writeSyncStatus(file, status);
    if (why !== said) {
      log(`sync:${name}`, `not linked yet (${why}); waiting. Link it from the setup page.`);
      said = why;
    }
    await sleep(LINK_POLL_MS);
  }
}

function startClient() {
  delete status.waiting;
  status.startedAt = now();
  status.lastOutputAt = now();
  status.lastLine = '';
  writeSyncStatus(file, status);

  child = spawn(obBin(cfg), ['sync', '--continuous', '--path', vault.dir], {
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

  child.on('error', (err) => fail(`sync:${name}`, `could not start ob: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (pending) clearTimeout(pending);
    writeSyncStatus(file, status);
    process.stderr.write(`[${name}] ob exited (${signal || `code ${code}`})\n`);
    process.exit(code ?? 1);
  });
}

await waitForLink();
startClient();
