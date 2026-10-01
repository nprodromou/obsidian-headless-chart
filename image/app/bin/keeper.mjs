#!/usr/bin/env node
// Keeper container: fast-forwards git-backed vaults on an interval, writes each
// vault's status note, and serves /metrics and /healthz for the whole pod.
// Runs even with no git-backed vaults, so sync metrics are still exported.
//
//   keeper.mjs            loop forever and serve HTTP
//   keeper.mjs --once     one pass, print results, exit (run by hand via kubectl exec)
//   keeper.mjs --dry-run  with --once: fetch and report, change nothing

import http from 'node:http';
import { createRequire } from 'node:module';
import { loadConfig } from '../lib/config.mjs';
import { setupGitEnv } from '../lib/gitenv.mjs';
import { processVault } from '../lib/keeper.mjs';
import { writeStatus } from '../lib/status.mjs';
import { renderMetrics } from '../lib/metrics.mjs';
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

// Healthy while a pass has finished recently. Three intervals of slack covers
// one slow fetch without flapping; a wedged loop still gets restarted.
function healthy() {
  const last = state.lastPassAt || state.startedAt;
  return now() - last <= cfg.intervalSeconds * 3 + 60;
}

const server = http.createServer((req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(renderMetrics(cfg, state));
  } else if (req.url === '/healthz') {
    const ok = healthy();
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'text/plain' });
    res.end(ok ? 'ok\n' : 'keeper pass overdue\n');
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(cfg.metricsPort, () => log(C, `serving /metrics and /healthz on :${cfg.metricsPort}`));

log(C, `${gitVaults.length} git-backed vault(s), every ${cfg.intervalSeconds}s`);
pass();
const timer = setInterval(pass, cfg.intervalSeconds * 1000);

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
