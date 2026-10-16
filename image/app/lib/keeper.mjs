// Keeps a git-backed vault current with its remote default branch.
//
// Per vault it only ever runs: fetch, a fast-forward-only merge when the clone
// is on the default branch, clean, and has no local commits, an index refresh
// of clean-filtered files whose content matches the index, and (opt-in) a
// restore from HEAD of changed tracked files that match discardLocalChanges.
// It never commits, checks out another branch, resets, stashes or cleans.
// Anything unexpected is reported and left for a human.
//
// Every git call is async with a timeout. The same process serves /healthz, and
// a synchronous fetch stuck on a slow connect stopped it answering until the
// liveness probe killed the container (OPS-1431).

import fs from 'node:fs';
import { run, runAsync, firstLine } from './proc.mjs';
import { matchesAny } from './glob.mjs';

export const STATES = ['OK', 'DIRTY', 'OFF-BRANCH', 'DIVERGED', 'FF-FAILED', 'FETCH-FAILED', 'NOT-A-REPO'];

// Fetch and `lfs pull` talk to the remote; everything else is local. A network
// call is bounded well inside the three intervals /healthz allows a pass, so a
// hung connect costs one FETCH-FAILED pass instead of the container.
export const LOCAL_TIMEOUT_MS = 120 * 1000;
export function networkTimeoutMs(cfg) {
  return Math.min(300, cfg.intervalSeconds) * 1000;
}

const MAX_BUFFER = 64 * 1024 * 1024;

function git(dir, args, opts = {}) {
  return runAsync('git', ['-C', dir, ...args], { timeoutMs: LOCAL_TIMEOUT_MS, maxBuffer: MAX_BUFFER, ...opts });
}

function gitIn(dir) {
  return (...args) => git(dir, args);
}

// First line of a failed call's output, or that it timed out.
function why(res) {
  if (res.timedOut) return 'timed out';
  return firstLine(res.stderr || res.stdout) || (res.error ? res.error.message : `exit ${res.status}`);
}

async function usesLfs(dir) {
  return (await git(dir, ['grep', '-q', 'filter=lfs', 'HEAD', '--', '.gitattributes', '*/.gitattributes'])).ok;
}

// Tracked files with worktree or index changes, from `status --porcelain -z`.
export async function changedTrackedFiles(dir) {
  const res = await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=no']);
  if (!res.ok) return [];
  const parts = res.stdout.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    files.push(entry.slice(3));
    // Renames and copies carry the original path as the next NUL field.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return files;
}

// Paths that `status` lists as changed only because the index holds stale stat
// data for a clean-filtered file. git skips re-hashing when the on-disk size
// differs from the index size, so a filter whose output is smaller than the
// worktree file (LFS: real content on disk, a pointer in the index) reads as
// modified forever, and `update-index --refresh` can't clear it. These are the
// changed files that have a filter attribute and whose clean output hashes to
// the index blob with the same mode: no content change at all.
export async function statOnlyFilteredFiles(dir, files) {
  const candidates = files.filter((f) => !f.includes('\n'));
  if (!candidates.length) return [];
  const attrs = await git(dir, ['check-attr', '-z', '--stdin', 'filter'],
    { input: candidates.join('\0') });
  if (!attrs.ok) return [];
  const a = attrs.stdout.split('\0');
  const filtered = [];
  for (let i = 0; i + 2 < a.length; i += 3) {
    if (!['unspecified', 'unset', 'set', ''].includes(a[i + 2])) filtered.push(a[i]);
  }
  const onDisk = filtered.filter((f) => {
    try {
      return fs.lstatSync(`${dir}/${f}`).isFile();
    } catch {
      return false;
    }
  });
  if (!onDisk.length) return [];

  const staged = await git(dir, ['ls-files', '-s', '-z', '--', ...onDisk.map((f) => `:(literal)${f}`)]);
  if (!staged.ok) return [];
  const index = new Map();
  for (const entry of staged.stdout.split('\0').filter(Boolean)) {
    const [meta, file] = entry.split('\t');
    const [mode, sha, stage] = meta.split(' ');
    if (stage === '0') index.set(file, { mode, sha });
  }
  const paths = onDisk.filter((f) => index.has(f));
  if (!paths.length) return [];
  const hashes = await git(dir, ['hash-object', '--stdin-paths'], { input: `${paths.join('\n')}\n` });
  if (!hashes.ok) return [];
  const shas = hashes.stdout.trim().split('\n');
  return paths.filter((f, i) => {
    const { mode, sha } = index.get(f);
    const exec = (fs.statSync(`${dir}/${f}`).mode & 0o111) !== 0;
    return shas[i] === sha && mode === (exec ? '100755' : '100644');
  });
}

export async function untrackedFiles(dir, excludes) {
  const pathspec = ['.', ...excludes.filter(Boolean).map((e) => `:(exclude)${e}`)];
  const res = await git(dir, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec]);
  if (!res.ok) return [];
  return res.stdout.split('\0').filter(Boolean);
}

export async function processVault(vault, cfg, { dryRun = false, fetchTimeoutMs = networkTimeoutMs(cfg) } = {}) {
  const dir = vault.dir;
  const g = gitIn(dir);
  const r = {
    vault: vault.name,
    dir,
    state: '',
    branch: '',
    defaultBranch: vault.git.branch || 'main',
    detail: '',
    dirty: [],
    untracked: [],
    discarded: [],
    refreshed: [],
    head: '',
    subject: '',
    commitEpoch: 0,
    behind: null,
  };

  // a. Must be the top level of a git work tree.
  if (!fs.existsSync(dir)) {
    return { ...r, state: 'NOT-A-REPO', detail: 'directory does not exist' };
  }
  const top = await g('rev-parse', '--show-toplevel');
  if (!top.ok || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(dir)) {
    return { ...r, state: 'NOT-A-REPO', detail: 'not the top level of a git clone' };
  }

  // b. Fetch. On failure keep going so the report reflects the last known state.
  const fetch = await git(dir, ['fetch', 'origin', '--prune', '--quiet'], { timeoutMs: fetchTimeoutMs });
  if (!fetch.ok) {
    r.detail = fetch.timedOut
      ? `fetch failed: timed out after ${Math.round(fetchTimeoutMs / 1000)}s`
      : `fetch failed: ${why(fetch)}`;
  }

  // c. Default branch: explicit config, then origin/HEAD, then main.
  if (!vault.git.branch) {
    const sym = await g('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    if (sym.ok && sym.stdout.trim()) r.defaultBranch = sym.stdout.trim().replace(/^origin\//, '');
  }
  const upstream = `refs/remotes/origin/${r.defaultBranch}`;
  const haveUpstream = (await g('rev-parse', '--verify', '--quiet', upstream)).ok;

  const sym = await g('symbolic-ref', '--short', '-q', 'HEAD');
  r.branch = sym.ok ? sym.stdout.trim() : '(detached HEAD)';

  r.untracked = await untrackedFiles(dir, [vault.configDir, cfg.statusFile]);

  if (!fetch.ok) {
    r.state = 'FETCH-FAILED';
  } else if (r.branch !== r.defaultBranch) {
    r.state = 'OFF-BRANCH';
  } else {
    r.dirty = await changedTrackedFiles(dir);

    // d. Re-stage files whose only change is stale index stat data. The clean
    // filter gives back the blob already in the index, so `add` changes no
    // content; it records the real file's stat so status stops listing it.
    // This runs before the restore, which would replace LFS content with a
    // pointer.
    const statOnly = await statOnlyFilteredFiles(dir, r.dirty);
    if (statOnly.length) {
      if (dryRun) {
        r.refreshed = statOnly;
        r.dirty = r.dirty.filter((f) => !statOnly.includes(f));
      } else {
        const res = await git(dir, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
          { input: statOnly.map((f) => `:(literal)${f}`).join('\0') });
        if (res.ok) {
          r.refreshed = statOnly;
          r.dirty = await changedTrackedFiles(dir);
        } else {
          r.detail = `index refresh failed: ${why(res)}`;
        }
      }
    }

    // e. Restore changed files the operator has declared disposable. Git is
    // the source of truth for them; Sync then pushes the restored version.
    const globs = vault.git.discardLocalChanges || [];
    const discard = globs.length ? r.dirty.filter((f) => matchesAny(f, globs)) : [];
    if (discard.length) {
      if (dryRun) {
        r.discarded = discard;
        r.dirty = r.dirty.filter((f) => !discard.includes(f));
      } else {
        const res = await git(dir, ['restore', '--source=HEAD', '--staged', '--worktree',
          '--pathspec-from-file=-', '--pathspec-file-nul'], { input: discard.join('\0') });
        if (res.ok) {
          r.discarded = discard;
          r.dirty = await changedTrackedFiles(dir);
        } else {
          r.detail = `restore failed: ${why(res)}`;
        }
      }
    }

    if (r.dirty.length) {
      r.state = 'DIRTY';
    } else if (!haveUpstream) {
      r.state = 'FF-FAILED';
      r.detail = `origin/${r.defaultBranch} not found`;
    } else {
      const ahead = Number((await g('rev-list', '--count', `${upstream}..HEAD`)).stdout.trim() || 0);
      if (ahead > 0) {
        r.state = 'DIVERGED';
        r.detail = `${ahead} local commit(s) not on origin/${r.defaultBranch}`;
      } else if (dryRun) {
        r.state = 'OK';
        const n = (await g('rev-list', '--count', `HEAD..${upstream}`)).stdout.trim();
        r.detail = `dry-run: would fast-forward ${n} commit(s)`;
      } else {
        const merge = await g('merge', '--ff-only', '--quiet', upstream);
        if (merge.ok) {
          r.state = 'OK';
          if (cfg.lfs && await usesLfs(dir)) {
            const lfs = await git(dir, ['lfs', 'pull'], { timeoutMs: fetchTimeoutMs });
            if (!lfs.ok) r.detail = `git lfs pull failed (non-fatal): ${why(lfs)}`;
          }
        } else {
          r.state = 'FF-FAILED';
          r.detail = `merge --ff-only failed: ${why(merge)}`;
        }
      }
    }
  }

  // Report HEAD and distance from origin after whatever ran above.
  if ((await g('rev-parse', '--verify', '--quiet', 'HEAD')).ok) {
    const info = (await g('log', '-1', '--format=%h%x00%s%x00%ct')).stdout.trim().split('\0');
    r.head = info[0] || '';
    r.subject = info[1] || '';
    r.commitEpoch = Number(info[2] || 0);
    if (haveUpstream) r.behind = Number((await g('rev-list', '--count', `HEAD..${upstream}`)).stdout.trim() || 0);
  }
  return r;
}

export function isTracked(dir, file) {
  return run('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', file]).ok;
}
