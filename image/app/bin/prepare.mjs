#!/usr/bin/env node
// Init container: install the client, clone git-backed vaults, and link each
// vault to its remote. Runs to completion before any sync container starts,
// which is what guarantees a git vault is cloned before Sync ever touches it.
//
// Secret mode (authMode secret): every vault must link, or the pod stops here.
// Wizard mode (authMode file): install and clone fail hard exactly as in Secret
// mode, but a vault that can't be linked yet (nobody has logged in, or it needs
// an E2E password nobody has given) is skipped. Its sync container waits for
// the link, which the setup page makes.
//
//   prepare.mjs                 full init
//   prepare.mjs --install-only  install the client and exit (image smoke test)

import fs from 'node:fs';
import { loadConfig, vaultPassword } from '../lib/config.mjs';
import { existingCloneProblem } from '../lib/clone.mjs';
import { setupGitEnv, usesLfs } from '../lib/gitenv.mjs';
import { hasAuthToken, installClient, ob, obVersion } from '../lib/ob.mjs';
import { applySyncConfig, linkStatus, setupLink } from '../lib/link.mjs';
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

// Secret mode: every vault must end up linked, or the pod does not start.
async function ensureLinked(vault, cfg, exec) {
  const st = await linkStatus(vault, exec);
  if (st.state === 'linked') {
    log(C, `${vault.name}: linked to "${st.vaultName}"`);
    return;
  }
  if (st.state !== 'unlinked') fail(C, `${vault.name}: ${st.message}`);
  const pw = vault.encrypted ? vaultPassword(vault) : '';
  if (vault.encrypted && !pw) fail(C, `${vault.name}: encrypted is true but VAULT_${vault.index}_PASSWORD is empty`);
  log(C, `${vault.name}: linking to remote vault "${vault.remote}"`);
  const res = await setupLink(vault, cfg, exec, pw);
  if (!res.ok) fail(C, `${vault.name}: ${res.message}`);
}

// Wizard mode: link what can be linked, and leave the rest for the setup page.
// A directory linked to a different remote still stops the pod, exactly as in
// Secret mode. Returns whether the vault is linked.
async function tryLink(vault, cfg, exec, loggedIn) {
  const st = await linkStatus(vault, exec);
  if (st.state === 'linked') {
    log(C, `${vault.name}: linked to "${st.vaultName}"`);
    return true;
  }
  if (st.state === 'mismatch') fail(C, `${vault.name}: ${st.message}`);
  if (st.state === 'error') {
    log(C, `${vault.name}: not linked (${st.message}); link it from the setup page`);
    return false;
  }
  if (!loggedIn) {
    log(C, `${vault.name}: not linked, and nobody has logged in yet; log in and link it from the setup page`);
    return false;
  }
  log(C, `${vault.name}: linking to remote vault "${vault.remote}"`);
  const res = await setupLink(vault, cfg, exec, vault.encrypted ? vaultPassword(vault) : '');
  if (!res.ok) {
    log(C, `${vault.name}: not linked (${res.message}); link it from the setup page`);
    return false;
  }
  return true;
}

async function configure(vault, cfg, exec) {
  const res = await applySyncConfig(vault, cfg, exec);
  if (!res.ok) fail(C, `${vault.name}: ${res.message}`);
  log(C, `${vault.name}: ${res.message}`);
}

async function main() {
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

  const wizard = cfg.authMode === 'file';
  if (!wizard && !process.env.OBSIDIAN_AUTH_TOKEN) fail(C, 'OBSIDIAN_AUTH_TOKEN is not set');
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
  // Secrets reach ob on stdin (the `input` option), never in argv.
  const exec = async (args, { input = '' } = {}) => ob(cfg, args, { input });
  if (!wizard) {
    for (const vault of cfg.vaults) {
      await ensureLinked(vault, cfg, exec);
      await configure(vault, cfg, exec);
    }
    log(C, `ready: ${cfg.vaults.length} vault(s)`);
    return;
  }

  const loggedIn = hasAuthToken();
  let linked = 0;
  for (const vault of cfg.vaults) {
    if (!(await tryLink(vault, cfg, exec, loggedIn))) continue;
    await configure(vault, cfg, exec);
    linked += 1;
  }
  log(C, `ready: ${linked} of ${cfg.vaults.length} vault(s) linked`
    + (linked < cfg.vaults.length ? '; the others wait for the setup page (see the keeper log for its setup code)' : ''));
}

await main();
