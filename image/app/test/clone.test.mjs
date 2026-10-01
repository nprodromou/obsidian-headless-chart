import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isolateGit, makeFixture, git } from './helpers.mjs';
import { existingCloneProblem, sameRepository } from '../lib/clone.mjs';

before(isolateGit);

test('accepts an existing clone of the configured repository', () => {
  const fx = makeFixture();
  assert.equal(existingCloneProblem(fx.vault), null);
  assert.equal(existingCloneProblem({ ...fx.vault, git: { repository: `${fx.origin}/` } }), null);
});

test('refuses an existing clone whose origin is another repository', () => {
  const fx = makeFixture();
  const moved = path.join(fx.root, 'moved.git');
  const problem = existingCloneProblem({ ...fx.vault, git: { ...fx.vault.git, repository: moved } });
  assert.match(problem, /is a clone of ".*origin\.git", not ".*moved\.git"/);
});

test('refuses an existing clone with no origin', () => {
  const fx = makeFixture();
  git(fx.vaultDir, 'remote', 'remove', 'origin');
  assert.match(existingCloneProblem(fx.vault), /\(no origin\)/);
});

test('refuses a non-empty directory that is not a clone', () => {
  const fx = makeFixture();
  const dir = path.join(fx.root, 'data', 'vaults', 'plain');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), 'x\n');
  assert.match(existingCloneProblem({ ...fx.vault, dir }), /is not a git clone/);
});

test('an insteadOf rewrite does not make a different URL match', () => {
  const fx = makeFixture();
  const other = 'https://example.invalid/other.git';
  git(fx.vaultDir, 'config', `url.${fx.origin}.insteadOf`, other);
  assert.match(existingCloneProblem({ ...fx.vault, git: { ...fx.vault.git, repository: other } }), /is a clone of/);
});

test('repository comparison', () => {
  assert.ok(sameRepository('https://github.com/you/notes.git', 'https://github.com/you/notes'));
  assert.ok(sameRepository('git@github.com:you/notes.git', 'git@github.com:you/notes.git/'));
  assert.ok(!sameRepository('https://github.com/you/notes.git', 'https://github.com/you/handbook.git'));
  assert.ok(!sameRepository('', ''));
});
