import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateGit, makeFixture, git } from './helpers.mjs';
import { processVault } from '../lib/keeper.mjs';
import { writeStatus } from '../lib/status.mjs';

before(isolateGit);

test('fast-forwards a clean clone to origin', () => {
  const f = makeFixture();
  f.commitUpstream('docs/briefs/today.md', 'brief 2\n');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'OK');
  assert.equal(r.behind, 0);
  assert.equal(fs.readFileSync(path.join(f.vaultDir, 'docs/briefs/today.md'), 'utf8'), 'brief 2\n');
});

test('refuses to fast-forward over a local edit and reports DIRTY', () => {
  const f = makeFixture();
  f.commitUpstream('README.md', '# notes v2\n');
  fs.writeFileSync(path.join(f.vaultDir, 'docs/briefs/today.md'), '---\naliases: []\n---\nbrief 1\n');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'DIRTY');
  assert.deepEqual(r.dirty, ['docs/briefs/today.md']);
  assert.equal(r.behind, 1);
});

test('restores edits matching discardLocalChanges, then fast-forwards', () => {
  const f = makeFixture({ discardLocalChanges: ['docs/briefs/**'] });
  f.commitUpstream('docs/briefs/today.md', 'brief 2\n');
  fs.writeFileSync(path.join(f.vaultDir, 'docs/briefs/today.md'), '---\naliases: []\n---\nbrief 1\n');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'OK');
  assert.deepEqual(r.discarded, ['docs/briefs/today.md']);
  assert.equal(fs.readFileSync(path.join(f.vaultDir, 'docs/briefs/today.md'), 'utf8'), 'brief 2\n');
});

test('restores a deleted file that matches discardLocalChanges', () => {
  const f = makeFixture({ discardLocalChanges: ['docs/briefs/'] });
  fs.rmSync(path.join(f.vaultDir, 'docs/briefs/today.md'));
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'OK');
  assert.ok(fs.existsSync(path.join(f.vaultDir, 'docs/briefs/today.md')));
});

test('an edit outside discardLocalChanges still blocks', () => {
  const f = makeFixture({ discardLocalChanges: ['docs/briefs/**'] });
  fs.writeFileSync(path.join(f.vaultDir, 'README.md'), 'edited on the phone\n');
  fs.writeFileSync(path.join(f.vaultDir, 'docs/briefs/today.md'), 'edited too\n');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'DIRTY');
  assert.deepEqual(r.dirty, ['README.md']);
  assert.deepEqual(r.discarded, ['docs/briefs/today.md']);
});

test('dry run reports what it would restore and changes nothing', () => {
  const f = makeFixture({ discardLocalChanges: ['docs/briefs/**'] });
  f.commitUpstream('README.md', '# v2\n');
  fs.writeFileSync(path.join(f.vaultDir, 'docs/briefs/today.md'), 'edited\n');
  const r = processVault(f.vault, f.cfg, { dryRun: true });
  assert.equal(r.state, 'OK');
  assert.deepEqual(r.discarded, ['docs/briefs/today.md']);
  assert.match(r.detail, /would fast-forward 1 commit/);
  assert.equal(fs.readFileSync(path.join(f.vaultDir, 'docs/briefs/today.md'), 'utf8'), 'edited\n');
  assert.equal(fs.readFileSync(path.join(f.vaultDir, 'README.md'), 'utf8'), '# notes\n');
});

test('reports OFF-BRANCH without touching the checkout', () => {
  const f = makeFixture();
  git(f.vaultDir, 'switch', '--quiet', '-c', 'parked');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'OFF-BRANCH');
  assert.equal(r.branch, 'parked');
  assert.equal(git(f.vaultDir, 'branch', '--show-current'), 'parked');
});

test('reports DIVERGED when the clone has local commits', () => {
  const f = makeFixture();
  fs.writeFileSync(path.join(f.vaultDir, 'local.md'), 'x\n');
  git(f.vaultDir, 'add', '-A');
  git(f.vaultDir, 'commit', '--quiet', '-m', 'local');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'DIVERGED');
  assert.match(r.detail, /1 local commit/);
});

test('reports NOT-A-REPO for a missing directory', () => {
  const f = makeFixture();
  fs.rmSync(f.vaultDir, { recursive: true });
  assert.equal(processVault(f.vault, f.cfg).state, 'NOT-A-REPO');
});

test('reports FETCH-FAILED when origin is unreachable', () => {
  const f = makeFixture();
  fs.rmSync(f.origin, { recursive: true });
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'FETCH-FAILED');
  assert.match(r.detail, /fetch failed/);
});

test('untracked listing skips the config dir and the status file', () => {
  const f = makeFixture();
  fs.mkdirSync(path.join(f.vaultDir, '.obsidian'));
  fs.writeFileSync(path.join(f.vaultDir, '.obsidian', 'app.json'), '{}');
  fs.writeFileSync(path.join(f.vaultDir, 'VAULT-STATUS.md'), 'old');
  fs.writeFileSync(path.join(f.vaultDir, 'today (conflicted).md'), 'x');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'OK');
  assert.deepEqual(r.untracked, ['today (conflicted).md']);
});

test('writes the status note, and refuses when the note is tracked', () => {
  const f = makeFixture();
  const r = processVault(f.vault, f.cfg);
  assert.equal(writeStatus(r, f.cfg), null);
  const note = fs.readFileSync(path.join(f.vaultDir, 'VAULT-STATUS.md'), 'utf8');
  assert.match(note, /State: \*\*OK\*\*/);
  assert.match(note, /by test-device/);
  assert.equal(processVault(f.vault, f.cfg).state, 'OK', 'the status note must not make the clone dirty');

  git(f.vaultDir, 'add', '-f', 'VAULT-STATUS.md');
  assert.match(writeStatus(r, f.cfg), /is tracked/);
});

// A stand-in for LFS with smudge skipped: the index holds a short pointer, the
// worktree holds the real (longer) content, and the clean filter maps that
// content back to the same pointer.
function filteredFixture() {
  const f = makeFixture();
  for (const dir of [f.upstream, f.vaultDir]) {
    git(dir, 'config', 'filter.fake.clean', 'sh -c "cat >/dev/null; echo pointer-1"');
    git(dir, 'config', 'filter.fake.smudge', 'cat');
  }
  fs.writeFileSync(path.join(f.upstream, '.gitattributes'), '*.pdf filter=fake\n');
  fs.writeFileSync(path.join(f.upstream, 'paper.pdf'), 'pointer-1\n');
  git(f.upstream, 'add', '-A');
  git(f.upstream, 'commit', '--quiet', '-m', 'add pdf');
  git(f.upstream, 'push', '--quiet', 'origin', 'HEAD:main');
  git(f.vaultDir, 'pull', '--quiet', '--ff-only');
  return f;
}

test('re-stages a filtered file whose only change is stale stat, then fast-forwards', () => {
  const f = filteredFixture();
  fs.writeFileSync(path.join(f.vaultDir, 'paper.pdf'), 'the real pdf bytes, longer than the pointer\n');
  assert.deepEqual(git(f.vaultDir, 'status', '--porcelain', '--untracked-files=no'), 'M paper.pdf');
  f.commitUpstream('README.md', '# notes v2\n');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'OK');
  assert.deepEqual(r.refreshed, ['paper.pdf']);
  assert.equal(r.behind, 0);
  assert.equal(git(f.vaultDir, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(fs.readFileSync(path.join(f.vaultDir, 'paper.pdf'), 'utf8'), 'the real pdf bytes, longer than the pointer\n');
  assert.equal(git(f.vaultDir, 'rev-parse', ':paper.pdf'), git(f.vaultDir, 'rev-parse', 'HEAD:paper.pdf'));
});

test('a real change to a filtered file still blocks', () => {
  const f = filteredFixture();
  git(f.vaultDir, 'config', 'filter.fake.clean', 'sh -c "cat >/dev/null; echo pointer-2"');
  fs.writeFileSync(path.join(f.vaultDir, 'paper.pdf'), 'a different pdf\n');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'DIRTY');
  assert.deepEqual(r.dirty, ['paper.pdf']);
  assert.deepEqual(r.refreshed, []);
});

test('a filtered file is refreshed before discardLocalChanges could restore its pointer', () => {
  const f = filteredFixture();
  f.vault.git.discardLocalChanges = ['**'];
  fs.writeFileSync(path.join(f.vaultDir, 'paper.pdf'), 'the real pdf bytes, longer than the pointer\n');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'OK');
  assert.deepEqual(r.refreshed, ['paper.pdf']);
  assert.deepEqual(r.discarded, []);
  assert.equal(fs.readFileSync(path.join(f.vaultDir, 'paper.pdf'), 'utf8'), 'the real pdf bytes, longer than the pointer\n');
});

test('dry run reports a stat-only refresh and leaves the index alone', () => {
  const f = filteredFixture();
  fs.writeFileSync(path.join(f.vaultDir, 'paper.pdf'), 'the real pdf bytes, longer than the pointer\n');
  const r = processVault(f.vault, f.cfg, { dryRun: true });
  assert.equal(r.state, 'OK');
  assert.deepEqual(r.refreshed, ['paper.pdf']);
  assert.equal(git(f.vaultDir, 'status', '--porcelain', '--untracked-files=no'), 'M paper.pdf');
});

test('an unfiltered edit is never re-staged', () => {
  const f = filteredFixture();
  fs.writeFileSync(path.join(f.vaultDir, 'README.md'), 'edited on the phone\n');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'DIRTY');
  assert.deepEqual(r.dirty, ['README.md']);
  assert.equal(git(f.vaultDir, 'diff', '--cached', '--name-only'), '');
});
