import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globToRegExp, matchesAny } from '../lib/glob.mjs';
import { normalizeConfig, vaultPassword } from '../lib/config.mjs';
import { formatTime, renderStatus } from '../lib/status.mjs';
import { renderMetrics } from '../lib/metrics.mjs';
import { syncStatusPath, writeSyncStatus } from '../lib/syncstatus.mjs';
import { runAsync } from '../lib/proc.mjs';

test('glob semantics', () => {
  assert.ok(matchesAny('docs/briefs/today.md', ['docs/briefs/**']));
  assert.ok(matchesAny('docs/briefs/2026/09/a.md', ['docs/briefs/']));
  assert.ok(matchesAny('a/b/c.md', ['**/*.md']));
  assert.ok(matchesAny('c.md', ['**/*.md']));
  assert.ok(!matchesAny('docs/x/today.md', ['docs/*.md']));
  assert.ok(matchesAny('docs/today.md', ['docs/*.md']));
  assert.ok(matchesAny('a.md', ['?.md']));
  assert.ok(!matchesAny('README.md', ['docs/**']));
  assert.ok(globToRegExp('a+b(c).md').test('a+b(c).md'));
});

test('config validation', () => {
  assert.throws(() => normalizeConfig({ vaults: [{ name: 'Bad_Name', remote: 'x' }] }), /name must match/);
  assert.throws(() => normalizeConfig({ vaults: [{ name: 'a', remote: 'x' }, { name: 'a', remote: 'y' }] }), /used twice/);
  assert.throws(() => normalizeConfig({ vaults: [{ name: 'a' }] }), /remote/);
  assert.throws(() => normalizeConfig({ vaults: [{ name: 'a', remote: 'x', sync: { mode: 'push-only' } }] }), /sync.mode/);
  assert.throws(() => normalizeConfig({ intervalSeconds: 5 }), /intervalSeconds/);
  const cfg = normalizeConfig({ vaults: [{ name: 'notes', remote: 'Notes', sync: { excludedFolders: [] } }] });
  const v = cfg.vaults[0];
  assert.equal(v.dir, '/data/vaults/notes');
  assert.equal(v.git, null);
  assert.deepEqual(v.sync.excludedFolders, []);
  assert.equal(v.sync.fileTypes, null);
  assert.equal(vaultPassword(v, { VAULT_0_PASSWORD: 'pw' }), 'pw');
});

test('time formatting honors the configured zone', () => {
  assert.equal(formatTime(1790000000, 'UTC'), '2026-09-21 14:13 UTC');
  assert.equal(formatTime(1790000000, 'America/Los_Angeles'), '2026-09-21 07:13 PDT');
});

test('status note includes a fix hint for a non-OK state', () => {
  const cfg = normalizeConfig({ deviceName: 'dev', fixCommand: 'kubectl -n obs exec deploy/x -c keeper --', vaults: [] });
  const note = renderStatus({
    state: 'DIRTY', dir: '/data/vaults/n', branch: 'main', defaultBranch: 'main', detail: '',
    dirty: ['a.md'], untracked: [], discarded: [], head: 'abc1234', subject: 'msg', commitEpoch: 1790000000, behind: 2,
  }, cfg, 1790000000);
  assert.match(note, /State: \*\*DIRTY\*\*/);
  assert.match(note, /Behind origin\/main: 2/);
  assert.match(note, /kubectl -n obs exec deploy\/x -c keeper -- git -C \/data\/vaults\/n status/);
  assert.match(note, /about 45 minutes old/);
});

test('metrics exposition', () => {
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-run-'));
  const cfg = normalizeConfig({ statusDir, vaults: [{ name: 'notes', remote: 'N', git: { repository: 'x' } }, { name: 'plain', remote: 'P' }] });
  writeSyncStatus(syncStatusPath(cfg, 'plain'), { startedAt: 100, lastOutputAt: 200, lastFullySyncedAt: 0 });
  const text = renderMetrics(cfg, {
    startedAt: 50,
    lastPassAt: 60,
    vaults: new Map([['notes', {
      result: { state: 'DIRTY', behind: 3, untracked: ['x'] }, stateSince: 55, discardedTotal: 2, refreshedTotal: 1,
    }]]),
  });
  assert.match(text, /obsidian_headless_git_state\{vault="notes",state="DIRTY"\} 1/);
  assert.match(text, /obsidian_headless_git_state\{vault="notes",state="OK"\} 0/);
  assert.match(text, /obsidian_headless_git_behind_commits\{vault="notes"\} 3/);
  assert.match(text, /obsidian_headless_git_discarded_files_total\{vault="notes"\} 2/);
  assert.match(text, /obsidian_headless_git_refreshed_files_total\{vault="notes"\} 1/);
  // Never reported "Fully synced" yet: falls back to the start time.
  assert.match(text, /obsidian_headless_sync_last_fully_synced_timestamp_seconds\{vault="plain"\} 100/);
  assert.doesNotMatch(text, /sync_started_timestamp_seconds\{vault="notes"\}/);
});

test('runAsync timeout kills the whole process group, not just the child', async () => {
  // The background sleep holds stdout open; killing only sh would leave the
  // call waiting on it, the way git-remote-https outlives a killed git fetch.
  const started = Date.now();
  const res = await runAsync('sh', ['-c', 'sleep 30 & wait'], { timeoutMs: 200 });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});

test('runAsync fails output past maxBuffer instead of truncating it', async () => {
  const res = await runAsync('sh', ['-c', 'head -c 2048 /dev/zero'], { maxBuffer: 1024 });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /exceeded 1024 bytes/);
  assert.equal((await runAsync('sh', ['-c', 'head -c 2048 /dev/zero'], { maxBuffer: 4096 })).ok, true);
});
