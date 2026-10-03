// Linking a vault directory to its remote vault, shared by the init container
// (prepare) and the setup wizard (keeper), so a vault is linked the same way
// whichever of them does it.
//
// Every function takes `exec(args, { input })`, which runs `ob` and resolves to
// { ok, status, stdout, stderr, timedOut }. prepare passes a synchronous runner
// wrapped in a promise; the keeper passes an async one with a timeout, so its
// HTTP listeners keep answering while the client works.
//
// The E2E password goes to the client on stdin. `ob sync-setup` without --json
// prompts for it when the vault needs one, and with stdin not a TTY a prompt
// reads stdin to EOF. So the password never appears in argv, where any process
// in the pod could read it, and an empty stdin is how we ask "does this vault
// need a password?" without guessing.

import { firstLine } from './proc.mjs';

export function remoteMatches(vault, linked) {
  return linked.vaultId === vault.remote || linked.vaultName === vault.remote;
}

// { state: 'linked', vaultId, vaultName }
// { state: 'mismatch', vaultId, vaultName, message }  linked, to another remote
// { state: 'unlinked', reason }                      not linked yet
// { state: 'error', message }                         could not tell
export async function linkStatus(vault, exec) {
  const res = await exec(['sync-status', '--path', vault.dir, '--json']);
  if (res.ok) {
    let linked;
    try {
      linked = JSON.parse(res.stdout);
    } catch {
      return { state: 'error', message: 'could not parse ob sync-status output' };
    }
    const { vaultId, vaultName } = linked;
    if (!remoteMatches(vault, linked)) {
      return {
        state: 'mismatch', vaultId, vaultName,
        message: `${vault.dir} is linked to remote vault "${vaultName}" (${vaultId}), not "${vault.remote}". `
          + `Unlink it with \`ob sync-unlink --path ${vault.dir}\` if the change is intended.`,
      };
    }
    return { state: 'linked', vaultId, vaultName };
  }
  // 3: no sync configuration for this path; 2: stored encryption key missing.
  if (res.status === 3) return { state: 'unlinked', reason: 'not linked' };
  if (res.status === 2) return { state: 'unlinked', reason: 'encryption key missing; link it again' };
  return { state: 'error', message: `ob sync-status failed (${exitText(res)}): ${firstLine(res.stderr)}` };
}

// `Multiple vaults named "X". Use the vault ID instead:` is followed by one
// `  <id>  "<name>"` line per candidate.
export function parseCandidates(stderr) {
  const out = [];
  for (const line of String(stderr || '').split('\n')) {
    const m = /^\s+(\S+)\s+"(.*)"\s*$/.exec(line);
    if (m) out.push({ id: m[1], name: m[2] });
  }
  return out;
}

// { ok: true }
// { ok: false, reason: 'needs-password' | 'bad-password' | 'ambiguous' | 'not-found' | 'failed',
//   message, candidates? }
export async function setupLink(vault, cfg, exec, password = '') {
  const res = await exec(['sync-setup', '--vault', vault.remote, '--path', vault.dir,
    '--device-name', cfg.deviceName, '--config-dir', vault.configDir], { input: password });
  if (res.ok) return { ok: true };
  const err = String(res.stderr || '');
  if (/Password not provided\./.test(err)) {
    return { ok: false, reason: 'needs-password', message: `remote vault "${vault.remote}" is end-to-end encrypted and needs its password` };
  }
  if (/Failed to validate password\./.test(err)) {
    return { ok: false, reason: 'bad-password', message: `the encryption password for "${vault.remote}" was not accepted` };
  }
  if (/Multiple vaults named/.test(err)) {
    return { ok: false, reason: 'ambiguous', candidates: parseCandidates(err),
      message: `more than one remote vault is named "${vault.remote}"; set remote to the vault ID instead` };
  }
  if (res.status === 3 && /not found/.test(err)) {
    return { ok: false, reason: 'not-found', message: `no remote vault named "${vault.remote}" on this account` };
  }
  return { ok: false, reason: 'failed', message: `ob sync-setup failed (${exitText(res)}): ${firstLine(err || res.stdout)}` };
}

export function syncConfigArgs(vault, cfg) {
  const s = vault.sync;
  const args = ['sync-config', '--path', vault.dir, '--mode', s.mode, '--conflict-strategy', s.conflictStrategy,
    '--device-name', cfg.deviceName, '--config-dir', vault.configDir, '--json'];
  if (s.excludedFolders !== null) args.push('--excluded-folders', s.excludedFolders.join(','));
  if (s.fileTypes !== null) args.push('--file-types', s.fileTypes.join(','));
  if (s.configs !== null) args.push('--configs', s.configs.join(','));
  return args;
}

// Applied on every start, and right after a link, so a values change takes
// effect on the next rollout and a fresh link starts with the declared settings.
export async function applySyncConfig(vault, cfg, exec) {
  const res = await exec(syncConfigArgs(vault, cfg));
  if (!res.ok) return { ok: false, message: `ob sync-config failed (${exitText(res)}): ${firstLine(res.stderr)}` };
  return { ok: true, message: `sync mode ${vault.sync.mode}, conflicts ${vault.sync.conflictStrategy}` };
}

function exitText(res) {
  if (res.timedOut) return 'timed out';
  return `exit ${res.status}`;
}
