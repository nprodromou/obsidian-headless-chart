#!/usr/bin/env node
// Init container: install the client, clone git-backed vaults, and link each
// vault to its remote. Runs to completion before any sync container starts,
// which is what guarantees a git vault is cloned before Sync ever touches it.
//
//   prepare.mjs                 full init
//   prepare.mjs --install-only  install the client and exit (image smoke test)

import fs from 'node:fs';
import { loadConfig, vaultPassword } from '../lib/config.mjs';
import { existingCloneProblem } from '../lib/clone.mjs';
import { setupGitEnv, usesLfs } from '../lib/gitenv.mjs';
import { installClient, ob, obVersion } from '../lib/ob.mjs';
import { run, firstLine } from '../lib/proc.mjs';
import { log, fail } from '../lib/log.mjs';

const C = 'prepare';
const installOnly = process.argv.includes('--install-only');

function isEmptyDir(dir) {
  return fs.readdirSync(dir).length === 0;
}

function ensureClone(vault, cfg) {
  const { dir } = vault;
  if (fs.existsSync(dir) && !isEmptyDir(dir)) {
    // The PVC outlives values changes, so prove this is the configured repo.
    // Rewriting origin here would have the keeper fast-forward a Sync-linked
    // vault onto another repository's files, so a mismatch stops the pod.
    const problem = existingCloneProblem(vault);
    if (problem) fail(C, `${vault.name}: ${problem}`);
    log(C, `${vault.name}: git clone of ${vault.git.repository} present`);
    return;
  }
  const args = ['clone', '--quiet'];
  if (vault.git.branch) args.push('--branch', vault.git.branch);
  args.push(vault.git.repository, dir);
  log(C, `${vault.name}: cloning ${vault.git.repository}`);
  const res = run('git', args, { env: { GIT_LFS_SKIP_SMUDGE: '1' } });
  if (!res.ok) fail(C, `${vault.name}: git clone failed: ${firstLine(res.stderr)}`);
  if (cfg.lfs && usesLfs(dir)) {
    const lfs = run('git', ['-C', dir, 'lfs', 'pull']);
    if (!lfs.ok) log(C, `${vault.name}: git lfs pull failed (non-fatal): ${firstLine(lfs.stderr)}`);
  }
}

function ensureLinked(vault, cfg) {
  const status = ob(cfg, ['sync-status', '--path', vault.dir, '--json']);
  if (status.ok) {
    let linked;
    try {
      linked = JSON.parse(status.stdout);
    } catch {
      fail(C, `${vault.name}: could not parse ob sync-status output`);
    }
    if (linked.vaultId !== vault.remote && linked.vaultName !== vault.remote) {
      fail(C, `${vault.name}: ${vault.dir} is linked to remote vault "${linked.vaultName}" (${linked.vaultId}), `
        + `not "${vault.remote}". Unlink it with \`ob sync-unlink --path ${vault.dir}\` if the change is intended.`);
    }
    log(C, `${vault.name}: linked to "${linked.vaultName}"`);
    return;
  }
  // 3: no sync configuration for this path; 2: stored encryption key missing.
  if (status.status !== 3 && status.status !== 2) {
    fail(C, `${vault.name}: ob sync-status failed (exit ${status.status}): ${firstLine(status.stderr)}`);
  }
  const args = ['sync-setup', '--vault', vault.remote, '--path', vault.dir,
    '--device-name', cfg.deviceName, '--config-dir', vault.configDir, '--json'];
  if (vault.encrypted) {
    const pw = vaultPassword(vault);
    if (!pw) fail(C, `${vault.name}: encrypted is true but VAULT_${vault.index}_PASSWORD is empty`);
    args.push('--password', pw);
  }
  log(C, `${vault.name}: linking to remote vault "${vault.remote}"`);
  const res = ob(cfg, args);
  if (!res.ok) fail(C, `${vault.name}: ob sync-setup failed (exit ${res.status}): ${firstLine(res.stderr)}`);
}

// Applied on every start so a values change takes effect on the next rollout.
function applySyncConfig(vault, cfg) {
  const s = vault.sync;
  const args = ['sync-config', '--path', vault.dir, '--mode', s.mode, '--conflict-strategy', s.conflictStrategy,
    '--device-name', cfg.deviceName, '--config-dir', vault.configDir, '--json'];
  if (s.excludedFolders !== null) args.push('--excluded-folders', s.excludedFolders.join(','));
  if (s.fileTypes !== null) args.push('--file-types', s.fileTypes.join(','));
  if (s.configs !== null) args.push('--configs', s.configs.join(','));
  const res = ob(cfg, args);
  if (!res.ok) fail(C, `${vault.name}: ob sync-config failed (exit ${res.status}): ${firstLine(res.stderr)}`);
  log(C, `${vault.name}: sync mode ${s.mode}, conflicts ${s.conflictStrategy}`);
}

function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    fail(C, `invalid config: ${err.message}`);
  }

  try {
    if (cfg.installClient) installClient(cfg, { log: (m) => log(C, m) });
    log(C, `client ${obVersion(cfg)}`);
  } catch (err) {
    fail(C, err.message);
  }
  if (installOnly) return;

  if (!process.env.OBSIDIAN_AUTH_TOKEN) fail(C, 'OBSIDIAN_AUTH_TOKEN is not set');
  if (!cfg.vaults.length) fail(C, 'no vaults configured');

  try {
    setupGitEnv(cfg);
  } catch (err) {
    fail(C, err.message);
  }
  fs.mkdirSync(`${cfg.dataDir}/vaults`, { recursive: true });
  if (process.env.XDG_CONFIG_HOME) fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });

  for (const vault of cfg.vaults) {
    if (vault.git) ensureClone(vault, cfg);
    else fs.mkdirSync(vault.dir, { recursive: true });
  }
  for (const vault of cfg.vaults) {
    ensureLinked(vault, cfg);
    applySyncConfig(vault, cfg);
  }
  log(C, `ready: ${cfg.vaults.length} vault(s)`);
}

main();
