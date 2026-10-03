// Runtime configuration, rendered by the chart into a ConfigMap as JSON.
// Secrets never appear here; they arrive as environment variables.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG_PATH = '/etc/obsidian-headless/config.json';

const VAULT_NAME = /^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$/;
const SYNC_MODES = ['bidirectional', 'pull-only', 'mirror-remote'];
const CONFLICT_STRATEGIES = ['merge', 'conflict'];
const AUTH_MODES = ['secret', 'file'];
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/i;

export function isLoopback(address) {
  return LOOPBACK.test(String(address).replace(/^\[|\]$/g, ''));
}

export function loadConfig(file = process.env.OBSIDIAN_HEADLESS_CONFIG || DEFAULT_CONFIG_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeConfig(raw);
}

export function normalizeConfig(raw) {
  const cfg = {
    dataDir: raw.dataDir || '/data',
    statusDir: raw.statusDir || '/run/obsidian-headless',
    deviceName: raw.deviceName || 'obsidian-headless-sync',
    installClient: raw.installClient !== false,
    // secret: OBSIDIAN_AUTH_TOKEN comes from obsidian.auth.existingSecret.
    // file:   no Secret; the token is the file `ob login` writes on the data
    //         volume, and the setup wizard is the way to write it.
    authMode: raw.authMode || 'secret',
    timezone: raw.timezone || 'UTC',
    statusFile: raw.statusFile ?? 'VAULT-STATUS.md',
    intervalSeconds: Number(raw.intervalSeconds || 900),
    lfs: raw.lfs !== false,
    metricsPort: Number(raw.metricsPort || 9090),
    fixCommand: raw.fixCommand || '',
    ui: normalizeUi(raw.ui || {}),
    vaults: [],
  };
  if (!AUTH_MODES.includes(cfg.authMode)) {
    throw new Error(`authMode must be one of ${AUTH_MODES.join(', ')}, got ${JSON.stringify(raw.authMode)}`);
  }
  if (cfg.ui.enabled && cfg.ui.port === cfg.metricsPort) {
    throw new Error(`ui.port must differ from metricsPort (both ${cfg.metricsPort})`);
  }
  if (!Number.isFinite(cfg.intervalSeconds) || cfg.intervalSeconds < 30) {
    throw new Error(`intervalSeconds must be >= 30, got ${raw.intervalSeconds}`);
  }
  const seen = new Set();
  (raw.vaults || []).forEach((v, index) => {
    if (!v || !VAULT_NAME.test(v.name || '')) {
      throw new Error(`vault ${index}: name must match ${VAULT_NAME} (got ${JSON.stringify(v && v.name)})`);
    }
    if (seen.has(v.name)) throw new Error(`vault name "${v.name}" is used twice`);
    seen.add(v.name);
    if (!v.remote) throw new Error(`vault "${v.name}": remote (vault name or ID) is required`);
    const sync = v.sync || {};
    if (sync.mode && !SYNC_MODES.includes(sync.mode)) {
      throw new Error(`vault "${v.name}": sync.mode must be one of ${SYNC_MODES.join(', ')}`);
    }
    if (sync.conflictStrategy && !CONFLICT_STRATEGIES.includes(sync.conflictStrategy)) {
      throw new Error(`vault "${v.name}": sync.conflictStrategy must be one of ${CONFLICT_STRATEGIES.join(', ')}`);
    }
    const git = v.git && v.git.repository ? {
      repository: v.git.repository,
      branch: v.git.branch || '',
      discardLocalChanges: v.git.discardLocalChanges || [],
    } : null;
    cfg.vaults.push({
      index,
      name: v.name,
      remote: String(v.remote),
      encrypted: Boolean(v.encrypted),
      configDir: sync.configDir || '.obsidian',
      sync: {
        mode: sync.mode || 'bidirectional',
        conflictStrategy: sync.conflictStrategy || 'merge',
        excludedFolders: sync.excludedFolders ?? null,
        fileTypes: sync.fileTypes ?? null,
        configs: sync.configs ?? null,
      },
      git,
      dir: path.join(cfg.dataDir, 'vaults', v.name),
    });
  });
  return cfg;
}

// The status page listener. Loopback by default: reaching it takes
// `kubectl port-forward`. A non-loopback address is the exposure opt-in and
// must name the Host headers it answers to.
function normalizeUi(raw) {
  const ui = {
    enabled: raw.enabled !== false,
    port: Number(raw.port || 8080),
    listenAddress: raw.listenAddress || '127.0.0.1',
    allowedHosts: (raw.allowedHosts || []).map((h) => String(h).toLowerCase()),
  };
  if (!Number.isInteger(ui.port) || ui.port < 1 || ui.port > 65535) {
    throw new Error(`ui.port must be a port number, got ${raw.port}`);
  }
  if (ui.enabled && !isLoopback(ui.listenAddress) && !ui.allowedHosts.length) {
    throw new Error(`ui.allowedHosts is required when ui.listenAddress (${ui.listenAddress}) is not loopback`);
  }
  return ui;
}

// The E2E password for vault N arrives as VAULT_<N>_PASSWORD (index, not name,
// so any vault name maps to a valid env var name).
export function vaultPassword(vault, env = process.env) {
  return env[`VAULT_${vault.index}_PASSWORD`] || '';
}

export function findVault(cfg, name) {
  const v = cfg.vaults.find((x) => x.name === name);
  if (!v) throw new Error(`no vault named "${name}" in config`);
  return v;
}
