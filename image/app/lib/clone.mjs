// Checks on a git vault the PVC already holds, before prepare trusts it.

import fs from 'node:fs';
import { run } from './proc.mjs';

// Trailing slashes and ".git" don't change which repository a URL names.
export function sameRepository(a, b) {
  const norm = (url) => String(url || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  return norm(a) !== '' && norm(a) === norm(b);
}

// Returns null when dir is a clone of vault.git.repository, or the reason it
// can't be used. The origin is read from config rather than `git remote
// get-url` so an insteadOf rewrite can't make two different values match.
export function existingCloneProblem(vault) {
  const { dir } = vault;
  const top = run('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!top.ok || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(dir)) {
    return `${dir} exists, is not empty, and is not a git clone. `
      + 'Move it aside or delete it; the chart will not sync a git vault into an unknown directory.';
  }
  const origin = run('git', ['-C', dir, 'config', '--get', 'remote.origin.url']).stdout.trim();
  if (!sameRepository(origin, vault.git.repository)) {
    return `${dir} is a clone of "${origin || '(no origin)'}", not "${vault.git.repository}". `
      + 'If the repository really moved, run `git -C ' + dir + ' remote set-url origin <url>`; '
      + 'if it is a different repository, move the directory aside so it is cloned fresh.';
  }
  return null;
}
