// One keeper pass over the git-backed vaults, recording results into the
// shared keeper state that /metrics, /healthz and the status page read.
//
// Vaults run one after another, and each one's network calls are bounded on
// their own. A shared outage can therefore make a whole pass take many times
// the per-vault bound, so liveness can't key on the pass finishing (OPS-1431).
// `lastProgressAt` moves when a pass starts and when each vault finishes;
// /healthz keys on that, so a pass that is still advancing stays healthy and a
// wedged one still goes stale. `lastPassAt` keeps meaning a finished pass.

import { processVault as defaultProcessVault } from './keeper.mjs';
import { writeStatus } from './status.mjs';
import { log as defaultLog } from './log.mjs';

const C = 'keeper';

export async function runPass(vaults, cfg, state, {
  dryRun = false,
  now = () => Math.floor(Date.now() / 1000),
  processVault = defaultProcessVault,
  log = (m) => defaultLog(C, m),
} = {}) {
  state.lastProgressAt = now();
  for (const vault of vaults) {
    let r;
    try {
      r = await processVault(vault, cfg, { dryRun });
    } catch (err) {
      log(`${vault.name}: keeper error: ${err.message}`);
      state.lastProgressAt = now();
      continue;
    }
    const prev = state.vaults.get(vault.name);
    state.vaults.set(vault.name, {
      result: r,
      stateSince: prev && prev.result.state === r.state ? prev.stateSince : now(),
      discardedTotal: (prev ? prev.discardedTotal : 0) + (dryRun ? 0 : r.discarded.length),
      refreshedTotal: (prev ? prev.refreshedTotal : 0) + (dryRun ? 0 : r.refreshed.length),
    });
    log(`${r.state.padEnd(12)} ${vault.name} branch=${r.branch || '-'} head=${r.head || '-'} `
      + `behind=${r.behind ?? '-'} untracked=${r.untracked.length} discarded=${r.discarded.length}`
      + `${r.detail ? ` (${r.detail})` : ''}`);
    for (const f of r.discarded) log(`${vault.name}: restored from git: ${f}`);
    for (const f of r.refreshed) log(`${vault.name}: refreshed stale index stat: ${f}`);
    if (!dryRun) {
      const warn = writeStatus(r, cfg);
      if (warn) log(`${vault.name}: WARN: ${warn}`);
    }
    state.lastProgressAt = now();
  }
  state.lastPassAt = now();
  state.lastProgressAt = state.lastPassAt;
}
