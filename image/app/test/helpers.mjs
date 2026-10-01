import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeConfig } from '../lib/config.mjs';

// Isolate every test from the developer's git config.
export function isolateGit() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-gitcfg-'));
  const cfgFile = path.join(dir, 'gitconfig');
  fs.writeFileSync(cfgFile, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  process.env.GIT_CONFIG_GLOBAL = cfgFile;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_TERMINAL_PROMPT = '0';
}

export function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

// An origin repo, an upstream working clone that "pushes new commits", and a
// data dir whose vaults/<name> is a clone of origin, like the init container
// leaves it.
export function makeFixture({ name = 'notes', discardLocalChanges = [], statusFile = 'VAULT-STATUS.md' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-'));
  const origin = path.join(root, 'origin.git');
  const upstream = path.join(root, 'upstream');
  const dataDir = path.join(root, 'data');
  execFileSync('git', ['init', '--quiet', '--bare', origin]);
  execFileSync('git', ['clone', '--quiet', origin, upstream], { stdio: 'ignore' });
  fs.mkdirSync(path.join(upstream, 'docs', 'briefs'), { recursive: true });
  fs.writeFileSync(path.join(upstream, 'README.md'), '# notes\n');
  fs.writeFileSync(path.join(upstream, 'docs', 'briefs', 'today.md'), 'brief 1\n');
  git(upstream, 'add', '-A');
  git(upstream, 'commit', '--quiet', '-m', 'initial');
  git(upstream, 'push', '--quiet', 'origin', 'HEAD:main');
  const vaultDir = path.join(dataDir, 'vaults', name);
  fs.mkdirSync(path.dirname(vaultDir), { recursive: true });
  execFileSync('git', ['clone', '--quiet', origin, vaultDir]);

  const cfg = normalizeConfig({
    dataDir,
    statusDir: path.join(root, 'run'),
    deviceName: 'test-device',
    timezone: 'UTC',
    statusFile,
    lfs: false,
    vaults: [{ name, remote: 'Notes', git: { repository: origin, discardLocalChanges } }],
  });
  const commitUpstream = (file, content, msg = 'update') => {
    fs.mkdirSync(path.dirname(path.join(upstream, file)), { recursive: true });
    fs.writeFileSync(path.join(upstream, file), content);
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '--quiet', '-m', msg);
    git(upstream, 'push', '--quiet', 'origin', 'HEAD:main');
  };
  return { root, origin, upstream, vaultDir, cfg, vault: cfg.vaults[0], commitUpstream };
}
