#!/usr/bin/env node
// Keeper container: fast-forwards git-backed vaults on an interval, writes each
// vault's status note, serves /metrics and /healthz for the whole pod, and
// serves the status page on a separate loopback listener. In wizard mode (no
// auth Secret) that listener also serves the setup wizard, gated by a setup
// code printed once to this log.
// Runs even with no git-backed vaults, so sync metrics are still exported.
//
//   keeper.mjs            loop forever and serve HTTP
//   keeper.mjs --once     one pass, print results, exit (run by hand via kubectl exec)
//   keeper.mjs --dry-run  with --once: fetch and report, change nothing

import { createRequire } from 'node:module';
import { loadConfig } from '../lib/config.mjs';
import { setupGitEnv } from '../lib/gitenv.mjs';
import { processVault } from '../lib/keeper.mjs';
import { writeStatus } from '../lib/status.mjs';
import { createMetricsServer, createUiServer } from '../lib/server.mjs';
import { createWizard } from '../lib/wizard.mjs';
import { hasAuthToken, obAsync } from '../lib/ob.mjs';
import { log, fail } from '../lib/log.mjs';

const C = 'keeper';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  const pkg = createRequire(import.meta.url)('../package.json');
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
const once = args.includes('--once');
const dryRun = args.includes('--dry-run');

let cfg;
try {
  cfg = loadConfig();
  setupGitEnv(cfg);
} catch (err) {
  fail(C, err.message);
}

const now = () => Math.floor(Date.now() / 1000);
const state = { startedAt: now(), lastPassAt: 0, vaults: new Map() };
const gitVaults = cfg.vaults.filter((v) => v.git);

function pass() {
  for (const vault of gitVaults) {
    let r;
    try {
      r = processVault(vault, cfg, { dryRun });
    } catch (err) {
      log(C, `${vault.name}: keeper error: ${err.message}`);
      continue;
    }
    const prev = state.vaults.get(vault.name);
    state.vaults.set(vault.name, {
      result: r,
      stateSince: prev && prev.result.state === r.state ? prev.stateSince : now(),
      discardedTotal: (prev ? prev.discardedTotal : 0) + (dryRun ? 0 : r.discarded.length),
    });
    log(C, `${r.state.padEnd(12)} ${vault.name} branch=${r.branch || '-'} head=${r.head || '-'} `
      + `behind=${r.behind ?? '-'} untracked=${r.untracked.length} discarded=${r.discarded.length}`
      + `${r.detail ? ` (${r.detail})` : ''}`);
    for (const f of r.discarded) log(C, `${vault.name}: restored from git: ${f}`);
    if (!dryRun) {
      const warn = writeStatus(r, cfg);
      if (warn) log(C, `${vault.name}: WARN: ${warn}`);
    }
  }
  state.lastPassAt = now();
}

if (once) {
  pass();
  process.exit(0);
}

const server = createMetricsServer(cfg, state);
server.listen(cfg.metricsPort, () => log(C, `serving /metrics and /healthz on :${cfg.metricsPort}`));

let ui = null;
let wizard = null;
if (cfg.ui.enabled && cfg.authMode === 'file') {
  // The child never sees OBSIDIAN_AUTH_TOKEN: with it set, `ob login` would
  // revoke that token and write a file the client then ignores.
  const exec = (a, opts = {}) => obAsync(cfg, a, { ...opts, env: { ...(opts.env || {}), OBSIDIAN_AUTH_TOKEN: undefined } });
  wizard = createWizard(cfg, { exec, hasToken: hasAuthToken, log: (m) => log(C, m) });
} else if (cfg.authMode === 'file') {
  log(C, 'no auth Secret and ui.enabled is false: there is no setup page; log in with '
    + '`kubectl exec deploy/<release> -c keeper -- /data/.ob/node_modules/.bin/ob login`');
}
if (cfg.ui.enabled) {
  ui = createUiServer(cfg, state, { wizard, hasToken: hasAuthToken });
  ui.on('error', (err) => fail(C, `status page listener on ${cfg.ui.listenAddress}:${cfg.ui.port}: ${err.message}`));
  ui.listen(cfg.ui.port, cfg.ui.listenAddress, () => {
    log(C, `serving the status page on ${cfg.ui.listenAddress}:${cfg.ui.port}`);
    // Printed once per start. Useless without network reach to the listener,
    // which is loopback unless ui.listenAddress opts in.
    if (wizard) log(C, `setup code: ${wizard.code} (enter it at /setup on the status page)`);
  });
}

log(C, `${gitVaults.length} git-backed vault(s), every ${cfg.intervalSeconds}s`);
pass();
const timer = setInterval(pass, cfg.intervalSeconds * 1000);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    clearInterval(timer);
    if (ui) ui.close();
    server.close(() => process.exit(0));
  });
}
