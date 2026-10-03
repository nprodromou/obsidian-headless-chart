// Prometheus text exposition for the keeper's /metrics endpoint.

import { STATES } from './keeper.mjs';
import { readSyncStatus, syncStatusPath } from './syncstatus.mjs';

const P = 'obsidian_headless';

function esc(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

class Out {
  constructor() { this.lines = []; }
  metric(name, help, type, samples) {
    if (!samples.length) return;
    this.lines.push(`# HELP ${P}_${name} ${help}`, `# TYPE ${P}_${name} ${type}`);
    for (const [labels, value] of samples) {
      const l = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',');
      this.lines.push(`${P}_${name}${l ? `{${l}}` : ''} ${value}`);
    }
  }
  text() { return `${this.lines.join('\n')}\n`; }
}

// keeperState: { startedAt, lastPassAt, vaults: Map(name -> { result, stateSince, discardedTotal }) }
export function renderMetrics(cfg, keeperState) {
  const o = new Out();
  o.metric('keeper_started_timestamp_seconds', 'When the keeper process started.', 'gauge',
    [[{}, keeperState.startedAt]]);
  o.metric('keeper_last_pass_timestamp_seconds', 'When the keeper last finished a pass over all git vaults.', 'gauge',
    keeperState.lastPassAt ? [[{}, keeperState.lastPassAt]] : []);

  const gitVaults = [...keeperState.vaults.entries()];
  o.metric('git_state', 'Current keeper state of a git-backed vault (1 for the active state).', 'gauge',
    gitVaults.flatMap(([vault, v]) => STATES.map((s) => [{ vault, state: s }, v.result.state === s ? 1 : 0])));
  o.metric('git_state_since_timestamp_seconds', 'When the vault entered its current keeper state.', 'gauge',
    gitVaults.map(([vault, v]) => [{ vault }, v.stateSince]));
  o.metric('git_behind_commits', 'Commits on the remote default branch not yet in the vault.', 'gauge',
    gitVaults.filter(([, v]) => v.result.behind !== null).map(([vault, v]) => [{ vault }, v.result.behind]));
  o.metric('git_untracked_files', 'Untracked files in the vault clone (device edits or conflict files).', 'gauge',
    gitVaults.map(([vault, v]) => [{ vault }, v.result.untracked.length]));
  o.metric('git_discarded_files_total', 'Tracked files restored from git because they matched discardLocalChanges.', 'counter',
    gitVaults.map(([vault, v]) => [{ vault }, v.discardedTotal]));

  const sync = cfg.vaults.map((v) => [v.name, readSyncStatus(syncStatusPath(cfg, v.name))]).filter(([, s]) => s);
  o.metric('sync_started_timestamp_seconds', 'When the sync client for the vault last started.', 'gauge',
    sync.map(([vault, s]) => [{ vault }, s.startedAt]));
  o.metric('sync_last_output_timestamp_seconds', 'When the sync client last wrote any output.', 'gauge',
    sync.map(([vault, s]) => [{ vault }, s.lastOutputAt]));
  o.metric('sync_last_fully_synced_timestamp_seconds', 'When the sync client last reported "Fully synced" (falls back to its start time).', 'gauge',
    sync.map(([vault, s]) => [{ vault }, s.lastFullySyncedAt || s.startedAt]));
  o.metric('sync_linked', 'Whether the vault is linked to its remote (0 while its sync container waits for a link).', 'gauge',
    sync.map(([vault, s]) => [{ vault }, s.waiting === 'not-linked' ? 0 : 1]));
  return o.text();
}
