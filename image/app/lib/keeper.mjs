// Keeps a git-backed vault current with its remote default branch.
//
// Per vault it only ever runs: fetch, a fast-forward-only merge when the clone
// is on the default branch, clean, and has no local commits, and (opt-in) a
// restore from HEAD of changed tracked files that match discardLocalChanges.
// It never commits, checks out another branch, resets, stashes or cleans.
// Anything unexpected is reported and left for a human.

import fs from 'node:fs';
import { run, firstLine } from './proc.mjs';
import { matchesAny } from './glob.mjs';
import { usesLfs } from './gitenv.mjs';

export const STATES = ['OK', 'DIRTY', 'OFF-BRANCH', 'DIVERGED', 'FF-FAILED', 'FETCH-FAILED', 'NOT-A-REPO'];

function gitIn(dir) {
  return (...args) => run('git', ['-C', dir, ...args]);
}

// Tracked files with worktree or index changes, from `status --porcelain -z`.
export function changedTrackedFiles(dir) {
  const res = run('git', ['-C', dir, 'status', '--porcelain=v1', '-z', '--untracked-files=no']);
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

export function untrackedFiles(dir, excludes) {
  const pathspec = ['.', ...excludes.filter(Boolean).map((e) => `:(exclude)${e}`)];
  const res = run('git', ['-C', dir, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec]);
  if (!res.ok) return [];
  return res.stdout.split('\0').filter(Boolean);
}

export function processVault(vault, cfg, { dryRun = false } = {}) {
  const dir = vault.dir;
  const git = gitIn(dir);
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
    head: '',
    subject: '',
    commitEpoch: 0,
    behind: null,
  };

  // a. Must be the top level of a git work tree.
  if (!fs.existsSync(dir)) {
    return { ...r, state: 'NOT-A-REPO', detail: 'directory does not exist' };
  }
  const top = git('rev-parse', '--show-toplevel');
  if (!top.ok || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(dir)) {
    return { ...r, state: 'NOT-A-REPO', detail: 'not the top level of a git clone' };
  }

  // b. Fetch. On failure keep going so the report reflects the last known state.
  const fetch = git('fetch', 'origin', '--prune', '--quiet');
  if (!fetch.ok) r.detail = `fetch failed: ${firstLine(fetch.stderr || fetch.stdout)}`;

  // c. Default branch: explicit config, then origin/HEAD, then main.
  if (!vault.git.branch) {
    const sym = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    if (sym.ok && sym.stdout.trim()) r.defaultBranch = sym.stdout.trim().replace(/^origin\//, '');
  }
  const upstream = `refs/remotes/origin/${r.defaultBranch}`;
  const haveUpstream = git('rev-parse', '--verify', '--quiet', upstream).ok;

  const sym = git('symbolic-ref', '--short', '-q', 'HEAD');
  r.branch = sym.ok ? sym.stdout.trim() : '(detached HEAD)';

  r.untracked = untrackedFiles(dir, [vault.configDir, cfg.statusFile]);

  if (!fetch.ok) {
    r.state = 'FETCH-FAILED';
  } else if (r.branch !== r.defaultBranch) {
    r.state = 'OFF-BRANCH';
  } else {
    r.dirty = changedTrackedFiles(dir);

    // d. Restore changed files the operator has declared disposable. Git is
    // the source of truth for them; Sync then pushes the restored version.
    const globs = vault.git.discardLocalChanges || [];
    const discard = globs.length ? r.dirty.filter((f) => matchesAny(f, globs)) : [];
    if (discard.length) {
      if (dryRun) {
        r.discarded = discard;
        r.dirty = r.dirty.filter((f) => !discard.includes(f));
      } else {
        const res = run('git', ['-C', dir, 'restore', '--source=HEAD', '--staged', '--worktree',
          '--pathspec-from-file=-', '--pathspec-file-nul'], { input: discard.join('\0') });
        if (res.ok) {
          r.discarded = discard;
          r.dirty = changedTrackedFiles(dir);
        } else {
          r.detail = `restore failed: ${firstLine(res.stderr)}`;
        }
      }
    }

    if (r.dirty.length) {
      r.state = 'DIRTY';
    } else if (!haveUpstream) {
      r.state = 'FF-FAILED';
      r.detail = `origin/${r.defaultBranch} not found`;
    } else {
      const ahead = Number(git('rev-list', '--count', `${upstream}..HEAD`).stdout.trim() || 0);
      if (ahead > 0) {
        r.state = 'DIVERGED';
        r.detail = `${ahead} local commit(s) not on origin/${r.defaultBranch}`;
      } else if (dryRun) {
        r.state = 'OK';
        const n = git('rev-list', '--count', `HEAD..${upstream}`).stdout.trim();
        r.detail = `dry-run: would fast-forward ${n} commit(s)`;
      } else {
        const merge = git('merge', '--ff-only', '--quiet', upstream);
        if (merge.ok) {
          r.state = 'OK';
          if (cfg.lfs && usesLfs(dir)) {
            const lfs = git('lfs', 'pull');
            if (!lfs.ok) r.detail = 'git lfs pull failed (non-fatal)';
          }
        } else {
          r.state = 'FF-FAILED';
          r.detail = `merge --ff-only failed: ${firstLine(merge.stderr || merge.stdout)}`;
        }
      }
    }
  }

  // Report HEAD and distance from origin after whatever ran above.
  if (git('rev-parse', '--verify', '--quiet', 'HEAD').ok) {
    const info = git('log', '-1', '--format=%h%x00%s%x00%ct').stdout.trim().split('\0');
    r.head = info[0] || '';
    r.subject = info[1] || '';
    r.commitEpoch = Number(info[2] || 0);
    if (haveUpstream) r.behind = Number(git('rev-list', '--count', `HEAD..${upstream}`).stdout.trim() || 0);
  }
  return r;
}

export function isTracked(dir, file) {
  return run('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', file]).ok;
}
