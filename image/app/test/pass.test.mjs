import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { isolateGit, makeFixture, git } from './helpers.mjs';
import { networkTimeoutMs, processVault } from '../lib/keeper.mjs';
import { runPass } from '../lib/pass.mjs';
import { isHealthy } from '../lib/server.mjs';

before(isolateGit);

// The case from the OPS-1431 review: intervalSeconds 300, a fast pass, then a
// pass where three vaults' fetches all hang to the 300s timeout in the same
// outage. The pass takes about 900s, past the 960s window measured from the
// previous pass, but each vault finishing counts as progress.
test('a pass advancing through several hung fetches stays healthy', async () => {
  const fixtures = ['a', 'b', 'c'].map((name) => makeFixture({ name }));
  for (const f of fixtures) git(f.vaultDir, 'config', 'remote.origin.uploadpack', 'sh -c "sleep 30"');
  const cfg = { ...fixtures[0].cfg, intervalSeconds: 300, statusFile: 'VAULT-STATUS.md' };
  const vaults = fixtures.map((f) => f.vault);
  const window = cfg.intervalSeconds * 3 + 60;
  const hang = networkTimeoutMs(cfg) / 1000;
  assert.equal(hang, 300);

  let clock = 1_000_000;
  const now = () => clock;
  const state = { startedAt: clock, lastPassAt: 0, lastProgressAt: 0, vaults: new Map() };
  const quiet = { now, log: () => {} };

  // A fast pass, then the scheduler waits out the interval.
  await runPass(vaults, cfg, state, { ...quiet, processVault: async (v) => ({ ...(await processVault(v, cfg)), state: 'OK' }) });
  const firstPassAt = state.lastPassAt;
  clock += cfg.intervalSeconds;

  const seen = [];
  await runPass(vaults, cfg, state, {
    ...quiet,
    processVault: async (v, c, opts) => {
      const r = await processVault(v, c, { ...opts, fetchTimeoutMs: 200 });
      // The real call took 200ms; charge it what a hung fetch costs in production.
      clock += hang;
      seen.push({ vault: v.name, state: r.state, healthy: isHealthy(cfg, state, clock) });
      return r;
    },
  });

  assert.deepEqual(seen.map((s) => s.state), ['FETCH-FAILED', 'FETCH-FAILED', 'FETCH-FAILED']);
  assert.ok(seen.every((s) => s.healthy), JSON.stringify(seen));
  // Keyed on finished passes alone, the keeper would have gone unhealthy mid-pass.
  assert.ok(clock - firstPassAt > window, `${clock - firstPassAt}s since the last finished pass`);
  assert.equal(state.lastPassAt, clock);
  assert.ok(isHealthy(cfg, state, clock));
});

test('a vault that makes no progress for three intervals goes unhealthy', async () => {
  const cfg = { intervalSeconds: 300 };
  let clock = 1_000_000;
  const state = { startedAt: clock, lastPassAt: 0, lastProgressAt: 0, vaults: new Map() };
  const health = [];
  await runPass([{ name: 'wedged' }], cfg, state, {
    now: () => clock,
    log: () => {},
    processVault: async () => {
      clock += cfg.intervalSeconds * 3 + 61;
      health.push(isHealthy(cfg, state, clock));
      throw new Error('stuck');
    },
  });
  assert.deepEqual(health, [false]);
});
