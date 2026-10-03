import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isolateGit, makeFixture, git } from './helpers.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { processVault, STATES } from '../lib/keeper.mjs';
import { syncStatusPath, writeSyncStatus } from '../lib/syncstatus.mjs';
import { html, hostAllowed, hostOf, renderPage } from '../lib/ui.mjs';
import { createMetricsServer, createUiServer } from '../lib/server.mjs';

before(isolateGit);

const NOW = 1790000000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-run-'));
const XSS = '<img src=x onerror=alert(1)>.md';

function keeperState(entries = [], { lastPassAt = NOW - 10 } = {}) {
  return { startedAt: NOW - 100, lastPassAt, vaults: new Map(entries) };
}

function result(state, extra = {}) {
  return {
    vault: 'notes', dir: '/data/vaults/notes', state, branch: 'main', defaultBranch: 'main', detail: '',
    dirty: [], untracked: [], discarded: [], head: 'abc1234', subject: 'update', commitEpoch: NOW - 600, behind: 0,
    ...extra,
  };
}

// Sends a raw request so the Host header is exactly what a browser would send.
function request(server, { method = 'GET', path: p = '/', host } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, method, path: p, setHost: false,
      headers: host === undefined ? {} : { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function listening(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

test('html() escapes every markup character', () => {
  assert.equal(html(XSS), '&lt;img src=x onerror=alert(1)&gt;.md');
  assert.equal(html(`a&b"c'd`), 'a&amp;b&quot;c&#39;d');
  assert.equal(html(null), '');
});

test('Host parsing and allowlist', () => {
  assert.equal(hostOf('localhost:8080'), 'localhost');
  assert.equal(hostOf('[::1]:8080'), '[::1]');
  assert.equal(hostOf('LOCALHOST'), 'localhost');
  assert.equal(hostOf('a b'), '');
  assert.equal(hostOf('::1'), '');
  for (const h of ['localhost', 'localhost:8080', '127.0.0.1:1', '[::1]', '[::1]:8080']) {
    assert.ok(hostAllowed(h), h);
  }
  for (const h of ['', undefined, 'evil.example', 'evil.example:8080', 'localhost.evil.example', '127.0.0.1.nip.io', '127.0.0.2']) {
    assert.ok(!hostAllowed(h), String(h));
  }
  assert.ok(hostAllowed('sync.example.com:443', ['sync.example.com']));
  assert.ok(!hostAllowed('other.example.com', ['sync.example.com']));
});

test('page renders for a pod with no git vaults', () => {
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-run-'));
  const cfg = normalizeConfig({ statusDir, deviceName: 'dev', vaults: [{ name: 'plain', remote: 'Plain' }, { name: 'quiet', remote: 'Q' }] });
  writeSyncStatus(syncStatusPath(cfg, 'plain'), {
    startedAt: NOW - 300, lastOutputAt: NOW - 5, lastFullySyncedAt: NOW - 5, lastLine: 'Fully synced',
  });
  const page = renderPage(cfg, keeperState([], { lastPassAt: 0 }), NOW);
  assert.match(page, /no git-backed vaults/);
  assert.match(page, /<h2>plain<\/h2>/);
  assert.match(page, /<code>Fully synced<\/code>/);
  assert.match(page, /\(5s ago\)/);
  assert.match(page, /<h2>quiet<\/h2>[\s\S]*no status yet/);
  assert.doesNotMatch(page, /class="git"|class="state/);
  assert.doesNotMatch(page, /<script/i);
});

test('git vaults show as pending before the first pass', () => {
  const cfg = normalizeConfig({ statusDir: tmp(), vaults: [{ name: 'notes', remote: 'N', git: { repository: 'x' } }] });
  const page = renderPage(cfg, keeperState([], { lastPassAt: 0 }), NOW);
  assert.match(page, /pending: the keeper has not finished its first pass/);
  assert.match(page, /last pass never/);
  const after = renderPage(cfg, keeperState([]), NOW);
  assert.match(after, /keeper logged an error/);
});

test('page renders every keeper state, with the fix command for non-OK ones', () => {
  const cfg = normalizeConfig({ statusDir: tmp(), fixCommand: 'kubectl -n obs exec deploy/x -c keeper --',
    vaults: [{ name: 'notes', remote: 'N', git: { repository: 'x' } }] });
  for (const state of STATES) {
    const page = renderPage(cfg, keeperState([['notes', { result: result(state), stateSince: NOW - 7200, discardedTotal: 0 }]]), NOW);
    assert.match(page, new RegExp(`class="state (ok|bad)">${state}</span> since .*\\(2h ago\\)`), state);
    if (state === 'OK') {
      assert.doesNotMatch(page, /Fix:/);
    } else if (state === 'NOT-A-REPO') {
      assert.match(page, /Fix: the vault directory is not a git clone/);
    } else {
      assert.match(page, /Fix: .*kubectl -n obs exec deploy\/x -c keeper --/, state);
    }
  }
});

test('page escapes file names, log lines, subjects and details from a real clone', () => {
  const f = makeFixture();
  fs.writeFileSync(path.join(f.vaultDir, XSS), 'x');
  fs.writeFileSync(path.join(f.vaultDir, 'README.md'), 'edited\n');
  git(f.upstream, 'commit', '--quiet', '--allow-empty', '-m', '<script>alert(2)</script>');
  git(f.upstream, 'push', '--quiet', 'origin', 'HEAD:main');
  git(f.vaultDir, 'stash', '--quiet');
  const r = processVault(f.vault, f.cfg);
  assert.equal(r.state, 'OK');
  assert.deepEqual(r.untracked, [XSS]);
  fs.writeFileSync(path.join(f.vaultDir, 'README.md'), 'edited again\n');
  const dirty = processVault(f.vault, f.cfg);
  assert.equal(dirty.state, 'DIRTY');
  writeSyncStatus(syncStatusPath(f.cfg, 'notes'), { startedAt: NOW, lastOutputAt: NOW, lastFullySyncedAt: 0, lastLine: `Uploading ${XSS}` });

  const page = renderPage(f.cfg, keeperState([['notes', { result: dirty, stateSince: NOW, discardedTotal: 0 }]]), NOW);
  assert.ok(!page.includes('<img'), 'raw file name reached the page');
  assert.ok(!page.includes('<script'), 'raw commit subject reached the page');
  assert.match(page, /<code>&lt;img src=x onerror=alert\(1\)&gt;\.md<\/code>/);
  assert.match(page, /Uploading &lt;img src=x/);
  assert.match(page, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(page, /<code>README\.md<\/code>/);
});

test('UI server: page, security headers, Host rejection, methods', async (t) => {
  const cfg = normalizeConfig({ statusDir: tmp(), ui: { allowedHosts: ['Sync.Example.com'] },
    vaults: [{ name: 'plain', remote: 'P' }] });
  const server = await listening(createUiServer(cfg, keeperState()));
  t.after(() => server.close());

  const ok = await request(server, { host: 'localhost:8080' });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(ok.headers['content-security-policy'],
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal(ok.headers['referrer-policy'], 'no-referrer');
  assert.match(ok.body, /<h2>plain<\/h2>/);

  assert.equal((await request(server, { host: '[::1]:8080' })).status, 200);
  assert.equal((await request(server, { host: 'sync.example.com' })).status, 200);

  for (const host of ['attacker.example:8080', '', 'localhost.attacker.example']) {
    const bad = await request(server, { host });
    assert.equal(bad.status, 421, host);
    assert.doesNotMatch(bad.body, /plain/);
    assert.equal(bad.headers['content-security-policy'], ok.headers['content-security-policy']);
  }
  // Node refuses an HTTP/1.1 request with no Host header before the handler runs.
  assert.equal((await request(server, {})).status, 400);
  // Host is checked before routing.
  assert.equal((await request(server, { host: 'attacker.example', path: '/nope' })).status, 421);

  assert.equal((await request(server, { host: 'localhost', path: '/metrics' })).status, 404);
  assert.equal((await request(server, { host: 'localhost', path: '/?x=1' })).status, 200);
  const post = await request(server, { host: 'localhost', method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});

test('metrics server serves only /metrics and /healthz', async (t) => {
  const cfg = normalizeConfig({ statusDir: tmp(), vaults: [{ name: 'plain', remote: 'P' }] });
  const now = Math.floor(Date.now() / 1000);
  const server = await listening(createMetricsServer(cfg, { startedAt: now, lastPassAt: now, vaults: new Map() }));
  t.after(() => server.close());
  const m = await request(server, { host: 'x', path: '/metrics' });
  assert.equal(m.status, 200);
  assert.match(m.body, /obsidian_headless_keeper_started_timestamp_seconds/);
  assert.equal((await request(server, { host: 'x', path: '/healthz' })).status, 200);
  for (const p of ['/', '/index.html', '/status']) {
    assert.equal((await request(server, { host: 'localhost', path: p })).status, 404, p);
  }
});

test('ui config defaults and validation', () => {
  const cfg = normalizeConfig({ vaults: [] });
  assert.deepEqual(cfg.ui, { enabled: true, port: 8080, listenAddress: '127.0.0.1', allowedHosts: [] });
  assert.throws(() => normalizeConfig({ ui: { listenAddress: '0.0.0.0' } }), /allowedHosts is required/);
  assert.equal(normalizeConfig({ ui: { listenAddress: '::', allowedHosts: ['a'] } }).ui.listenAddress, '::');
  assert.equal(normalizeConfig({ ui: { listenAddress: '::1' } }).ui.listenAddress, '::1');
  assert.throws(() => normalizeConfig({ metricsPort: 9090, ui: { port: 9090 } }), /must differ/);
  assert.equal(normalizeConfig({ metricsPort: 9090, ui: { enabled: false, port: 9090 } }).ui.enabled, false);
});
