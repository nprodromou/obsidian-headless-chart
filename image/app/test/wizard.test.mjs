import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolateGit } from './helpers.mjs';
import { normalizeConfig } from '../lib/config.mjs';
import { authTokenPath, hasAuthToken, obAsync } from '../lib/ob.mjs';
import { linkStatus, parseCandidates, setupLink, syncConfigArgs } from '../lib/link.mjs';
import { renderMetrics } from '../lib/metrics.mjs';
import { readSyncStatus, syncStatusPath, writeSyncStatus } from '../lib/syncstatus.mjs';
import { renderPage } from '../lib/ui.mjs';
import { createUiServer } from '../lib/server.mjs';
import { COOKIE, createWizard, sameOrigin, slugFor, valuesSnippet } from '../lib/wizard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const FAKE_OB = path.join(HERE, 'fake-ob.mjs');
const CODE = '0123456789abcdef0123456789abcdef';

before(() => {
  isolateGit();
  fs.chmodSync(FAKE_OB, 0o755);
  process.env.OB_BIN = FAKE_OB;
});

// A data dir, a config dir for the token file, and the fake client's state.
function world({ authMode = 'file', vaults, remote, account = { password: 'pw' }, links = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ohs-wiz-'));
  const env = { OB_BIN: FAKE_OB, FAKE_OB_DIR: path.join(root, 'fake'), XDG_CONFIG_HOME: path.join(root, 'config') };
  fs.mkdirSync(env.FAKE_OB_DIR);
  const raw = {
    authMode, dataDir: path.join(root, 'data'), statusDir: path.join(root, 'run'), deviceName: 'dev', installClient: false, lfs: false,
    fixCommand: 'kubectl -n obs exec deploy/x -c keeper --',
    vaults: vaults || [{ name: 'plain', remote: 'Plain' }, { name: 'secret', remote: 'Secret' }],
  };
  const cfg = normalizeConfig(raw);
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(raw));
  fs.writeFileSync(path.join(env.FAKE_OB_DIR, 'account.json'), JSON.stringify(account));
  fs.writeFileSync(path.join(env.FAKE_OB_DIR, 'remote.json'), JSON.stringify(remote || {
    vaults: [{ id: 'id-plain', name: 'Plain' }, { id: 'id-secret', name: 'Secret', e2e: 'e2e-pw' }, { id: 'id-extra', name: 'Recipes & Notes' }],
    shared: [{ id: 'id-shared', name: 'Team' }],
  }));
  const linkMap = Object.fromEntries(Object.entries(links).map(([n, l]) => [path.join(raw.dataDir, 'vaults', n), l]));
  fs.writeFileSync(path.join(env.FAKE_OB_DIR, 'links.json'), JSON.stringify(linkMap));
  const readLog = (n) => {
    try { return fs.readFileSync(path.join(env.FAKE_OB_DIR, n), 'utf8'); } catch { return ''; }
  };
  const login = () => {
    fs.mkdirSync(path.dirname(authTokenPath(env)), { recursive: true });
    fs.writeFileSync(authTokenPath(env), 'tok');
  };
  return { root, env, cfg, configFile, readLog, login };
}

// The exec the keeper builds, pointed at the fake client.
function fakeExec(w) {
  return (args, opts = {}) => obAsync(w.cfg, args, { ...opts, env: { ...w.env, OBSIDIAN_AUTH_TOKEN: undefined } });
}

function request(server, { method = 'GET', path: p = '/', host = 'localhost:8080', origin, cookie, form } = {}) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const headers = { Host: host };
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    let body;
    if (form !== undefined) {
      body = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: p, setHost: false, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function listening(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

async function wizardServer(t, w, opts = {}) {
  const wizard = createWizard(w.cfg, { exec: opts.exec || fakeExec(w), hasToken: () => hasAuthToken(w.env), code: CODE });
  const server = await listening(createUiServer(w.cfg, { startedAt: 1, lastPassAt: 1, vaults: new Map() },
    { wizard, hasToken: () => hasAuthToken(w.env) }));
  t.after(() => server.close());
  return server;
}

const ORIGIN = 'http://localhost:8080';

async function session(server) {
  const res = await request(server, { method: 'POST', path: '/setup/code', origin: ORIGIN, form: { code: CODE } });
  assert.equal(res.status, 303);
  return res.headers['set-cookie'][0].split(';')[0];
}

// POST an action, follow the redirect, return the page.
async function act(server, cookie, p, form) {
  const res = await request(server, { method: 'POST', path: p, origin: ORIGIN, cookie, form });
  assert.equal(res.status, 303, `${p}: ${res.body}`);
  assert.equal(res.headers.location, '/setup');
  return (await request(server, { path: '/setup', cookie })).body;
}

// ---- shared linking code -------------------------------------------------

test('setupLink classifies the client\'s answers and passes the password on stdin', async () => {
  const calls = [];
  const reply = (r) => async (args, opts) => { calls.push({ args, opts }); return { ok: false, stdout: '', stderr: '', ...r }; };
  const cfg = normalizeConfig({ deviceName: 'dev', vaults: [{ name: 'v', remote: 'Notes' }] });
  const v = cfg.vaults[0];

  assert.deepEqual(await setupLink(v, cfg, reply({ ok: true, status: 0 })), { ok: true });
  assert.equal((await setupLink(v, cfg, reply({ status: 2, stderr: 'Password not provided.\n' }))).reason, 'needs-password');
  assert.equal((await setupLink(v, cfg, reply({ status: 2, stderr: 'Failed to validate password. s [Error]\n' }), 'pw')).reason, 'bad-password');
  assert.equal((await setupLink(v, cfg, reply({ status: 3, stderr: 'Vault "Notes" not found.\n' }))).reason, 'not-found');
  const amb = await setupLink(v, cfg, reply({ status: 1, stderr: 'Multiple vaults named "Notes". Use the vault ID instead:\n  id1  "Notes"\n  id2  "Notes"\n' }));
  assert.equal(amb.reason, 'ambiguous');
  assert.deepEqual(amb.candidates, [{ id: 'id1', name: 'Notes' }, { id: 'id2', name: 'Notes' }]);
  const t = await setupLink(v, cfg, reply({ status: null, timedOut: true }));
  assert.equal(t.reason, 'failed');
  assert.match(t.message, /timed out/);

  for (const { args, opts } of calls) {
    assert.ok(!args.includes('--json'), 'sync-setup must prompt (no --json) so the password can come on stdin');
    assert.ok(!args.includes('--password'));
  }
  assert.equal(calls[2].opts.input, 'pw');
  assert.equal(calls[0].opts.input, '');
});

test('parseCandidates and syncConfigArgs', () => {
  assert.deepEqual(parseCandidates('Multiple vaults named "A b". Use the vault ID instead:\n  x1  "A b"\n'), [{ id: 'x1', name: 'A b' }]);
  const cfg = normalizeConfig({ deviceName: 'dev', vaults: [{ name: 'v', remote: 'N', sync: { fileTypes: ['pdf'], configs: [] } }] });
  const args = syncConfigArgs(cfg.vaults[0], cfg);
  assert.deepEqual(args.slice(0, 3), ['sync-config', '--path', '/data/vaults/v']);
  assert.ok(args.includes('--file-types') && args.includes('--configs') && !args.includes('--excluded-folders'));
});

test('linkStatus: linked, linked elsewhere, not linked', async () => {
  const w = world({ links: { plain: { vaultId: 'id-plain', vaultName: 'Plain' }, secret: { vaultId: 'id-other', vaultName: 'Other' } } });
  const exec = fakeExec(w);
  assert.equal((await linkStatus(w.cfg.vaults[0], exec)).state, 'linked');
  const mm = await linkStatus(w.cfg.vaults[1], exec);
  assert.equal(mm.state, 'mismatch');
  assert.match(mm.message, /linked to remote vault "Other"/);
  const w2 = world();
  assert.deepEqual(await linkStatus(w2.cfg.vaults[0], fakeExec(w2)), { state: 'unlinked', reason: 'not linked' });
});

// ---- wizard helpers -------------------------------------------------------

test('sameOrigin, slugs and the values snippet', () => {
  assert.ok(sameOrigin('http://localhost:8080', 'localhost:8080'));
  assert.ok(sameOrigin('http://LOCALHOST:8080', 'localhost:8080'));
  assert.ok(sameOrigin('https://sync.example.com', 'sync.example.com'));
  assert.ok(sameOrigin('https://sync.example.com', 'sync.example.com:443'));
  for (const o of [undefined, '', 'null', 'http://evil.example', 'http://localhost:9999', 'file:///x', 'http://localhost:8080.evil.example']) {
    assert.ok(!sameOrigin(o, 'localhost:8080'), String(o));
  }
  const taken = new Set(['notes']);
  assert.equal(slugFor('Notes', taken), 'notes-2');
  assert.equal(slugFor('Recipes & Notes!', taken), 'recipes-notes');
  assert.equal(slugFor('日本', taken), 'vault');

  const cfg = normalizeConfig({ vaults: [{ name: 'notes', remote: 'Notes' }, { name: 'b', remote: 'id-b' }] });
  const snip = valuesSnippet(cfg, {
    vaults: [{ id: 'id-a', name: 'Notes' }, { id: 'id-b', name: 'B' }, { id: 'd1', name: 'Dup' }, { id: 'd2', name: 'Dup' }],
    shared: [{ id: 's', name: 'Team "X"' }],
  });
  assert.equal(snip, [
    'vaults:',
    '  - name: dup', '    remote: "d1"  # "Dup"',
    '  - name: dup-2', '    remote: "d2"  # "Dup"',
    '  - name: team-x', '    remote: "Team \\"X\\""',
  ].join('\n'));
  assert.equal(valuesSnippet(cfg, { vaults: [{ id: 'id-b', name: 'B' }] }), '');
});

// ---- wizard routes --------------------------------------------------------

test('Secret mode: no wizard routes, and the page says why', async (t) => {
  const w = world({ authMode: 'secret' });
  const server = await listening(createUiServer(w.cfg, { startedAt: 1, lastPassAt: 1, vaults: new Map() }));
  t.after(() => server.close());
  assert.equal((await request(server, { path: '/setup' })).status, 404);
  const post = await request(server, { method: 'POST', path: '/setup/login', origin: ORIGIN, form: { email: 'a@b', password: 'pw' } });
  assert.equal(post.status, 405);
  const page = await request(server, {});
  assert.match(page.body, /managed by a Secret/);
  assert.doesNotMatch(page.body, /href="\/setup"/);
});

test('setup code gate: code form, Origin check, cookie attributes', async (t) => {
  const w = world();
  const server = await wizardServer(t, w);

  const status = await request(server, {});
  assert.match(status.body, /not logged in/);
  assert.match(status.body, /href="\/setup"/);

  const form = await request(server, { path: '/setup' });
  assert.equal(form.status, 200);
  assert.match(form.body, /name="code"/);
  assert.match(form.body, /kubectl -n obs logs deploy\/x -c keeper \| grep 'setup code'/);
  assert.doesNotMatch(form.body, /name="email"/);
  assert.doesNotMatch(form.body, new RegExp(CODE));
  assert.doesNotMatch(form.body, /<script/i);

  // No Origin, a foreign one, and "null" are all refused before the code is read.
  for (const origin of [undefined, 'http://evil.example', 'null']) {
    const r = await request(server, { method: 'POST', path: '/setup/code', origin, form: { code: CODE } });
    assert.equal(r.status, 403, String(origin));
    assert.equal(r.headers['set-cookie'], undefined);
  }
  const wrong = await request(server, { method: 'POST', path: '/setup/code', origin: ORIGIN, form: { code: 'nope' } });
  assert.equal(wrong.status, 403);
  assert.match(wrong.body, /not the current setup code/);
  const json = await request(server, { method: 'POST', path: '/setup/code', origin: ORIGIN });
  assert.equal(json.status, 415);

  const ok = await request(server, { method: 'POST', path: '/setup/code', origin: ORIGIN, form: { code: CODE } });
  assert.equal(ok.status, 303);
  const cookie = ok.headers['set-cookie'][0];
  assert.match(cookie, new RegExp(`^${COOKIE}=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=/$`));
  assert.equal(ok.headers['content-security-policy'].includes("form-action 'self'"), true);
  const page = await request(server, { path: '/setup', cookie: cookie.split(';')[0] });
  assert.match(page.body, /name="email"/);

  // Actions need the session and the Origin, both.
  const noSession = await request(server, { method: 'POST', path: '/setup/login', origin: ORIGIN, form: { email: 'a@b.c', password: 'pw' } });
  assert.equal(noSession.status, 403);
  const forged = await request(server, { method: 'POST', path: '/setup/login', origin: 'http://evil.example', cookie: cookie.split(';')[0], form: { email: 'a@b.c', password: 'pw' } });
  assert.equal(forged.status, 403);
  assert.ok(!hasAuthToken(w.env));
  // The Host allowlist still comes first.
  assert.equal((await request(server, { path: '/setup', host: 'evil.example' })).status, 421);
  assert.equal((await request(server, { path: '/setup/nope', cookie: cookie.split(';')[0] })).status, 404);
});

test('login: wrong password, 2FA needed, then success; the password never reaches argv', async (t) => {
  const w = world({ account: { password: 'hunter2', mfa: '123456' } });
  const server = await wizardServer(t, w);
  const cookie = await session(server);

  let page = await act(server, cookie, '/setup/login', { email: 'me@example.com', password: 'wrong' });
  assert.match(page, /Login failed: Login failed, incorrect email or password\./);
  assert.doesNotMatch(page, /cli\.js/);
  page = await act(server, cookie, '/setup/login', { email: 'me@example.com', password: 'hunter2' });
  assert.match(page, /needs a 2FA code/);
  assert.ok(!hasAuthToken(w.env));
  page = await act(server, cookie, '/setup/login', { email: 'me@example.com', password: 'hunter2', mfa: '000000' });
  assert.match(page, /2FA code is incorrect/);
  page = await act(server, cookie, '/setup/login', { email: '--mfa=1', password: 'hunter2' });
  assert.match(page, /Enter the email address/);
  page = await act(server, cookie, '/setup/login', { email: 'me@example.com', password: 'hunter2', mfa: '123456' });
  assert.match(page, /Logged in as Test User \(me@example\.com\)/);
  assert.ok(hasAuthToken(w.env));

  // After login the page lists the declared vaults and the remote ones to add.
  assert.match(page, /<th>plain<\/th><td>Plain<\/td><td><span class="state pending">not linked/);
  assert.match(page, /- name: recipes-notes\n {4}remote: &quot;Recipes &amp; Notes&quot;/);
  assert.match(page, /- name: team\n/);
  assert.doesNotMatch(page, /name: plain\n/);

  const argv = w.readLog('argv.log');
  assert.ok(!argv.includes('hunter2'), 'password reached argv');
  assert.match(argv, /"login","--email=me@example.com","--mfa=123456"/);
  assert.match(w.readLog('stdin.log'), /"hunter2"/);
});

test('link: a plain vault, an E2E vault (asked, wrong, right), and the refusals', async (t) => {
  const w = world({
    vaults: [{ name: 'plain', remote: 'Plain', sync: { mode: 'pull-only' } }, { name: 'secret', remote: 'Secret' },
      { name: 'dup', remote: 'Dup' }, { name: 'moved', remote: 'Plain' }],
    remote: { vaults: [{ id: 'id-plain', name: 'Plain' }, { id: 'id-secret', name: 'Secret', e2e: 'e2e-pw' },
      { id: 'd1', name: 'Dup' }, { id: 'd2', name: 'Dup' }, { id: 'id-other', name: 'Other' }] },
    links: { moved: { vaultId: 'id-other', vaultName: 'Other' } },
  });
  const server = await wizardServer(t, w);
  const cookie = await session(server);

  let page = await act(server, cookie, '/setup/link', { vault: 'plain' });
  assert.match(page, /Log in first/);
  w.login();

  page = await act(server, cookie, '/setup/link', { vault: 'plain' });
  assert.match(page, /Linked plain; sync mode pull-only/);
  assert.match(page, /<th>plain<\/th>.*?<span class="state ok">linked<\/span> to Plain/);
  assert.match(w.readLog('config.log'), /"sync-config","--path","[^"]+\/vaults\/plain","--mode","pull-only"/);

  page = await act(server, cookie, '/setup/link', { vault: 'secret' });
  assert.match(page, /end-to-end encrypted and needs its password/);
  assert.match(page, /<input type="hidden" name="vault" value="secret">\n<label>End-to-end encryption password/);
  page = await act(server, cookie, '/setup/link', { vault: 'secret', password: 'nope' });
  assert.match(page, /was not accepted/);
  page = await act(server, cookie, '/setup/link', { vault: 'secret', password: 'e2e-pw' });
  assert.match(page, /Linked secret/);
  assert.ok(!w.readLog('argv.log').includes('e2e-pw'), 'E2E password reached argv');

  page = await act(server, cookie, '/setup/link', { vault: 'dup' });
  assert.match(page, /more than one remote vault is named &quot;Dup&quot;/);
  assert.match(page, /<code>d1<\/code> Dup<\/li><li><code>d2<\/code> Dup/);
  assert.match(page, /- name: dup\n {4}remote: &quot;d1&quot;/);

  const before = w.readLog('argv.log').split('\n').length;
  page = await act(server, cookie, '/setup/link', { vault: 'moved' });
  assert.match(page, /moved: .*is linked to remote vault &quot;Other&quot;/);
  const setups = w.readLog('argv.log').split('\n').slice(before - 1).filter((l) => l.includes('sync-setup'));
  assert.deepEqual(setups, [], 'linked-elsewhere vault was re-linked');

  page = await act(server, cookie, '/setup/link', { vault: 'nope' });
  assert.match(page, /No such vault/);
  page = await act(server, cookie, '/setup/link', { vault: 'plain' });
  assert.match(page, /plain is already linked/);
});

test('actions run one at a time; a login that times out without a code asks for one', async (t) => {
  const w = world();
  let release;
  const gate = new Promise((r) => { release = r; });
  const exec = async (args) => {
    if (args[0] === 'login') {
      await gate;
      return { ok: false, status: null, stdout: '', stderr: '', timedOut: true };
    }
    return { ok: false, status: 3, stdout: '', stderr: '' };
  };
  const server = await wizardServer(t, w, { exec });
  const cookie = await session(server);
  const first = request(server, { method: 'POST', path: '/setup/login', origin: ORIGIN, cookie, form: { email: 'a@b.c', password: 'pw' } });
  await new Promise((r) => setTimeout(r, 50));
  const second = await request(server, { method: 'POST', path: '/setup/login', origin: ORIGIN, cookie, form: { email: 'a@b.c', password: 'pw' } });
  assert.equal(second.status, 409);
  // The status page still answers while an action runs.
  assert.equal((await request(server, {})).status, 200);
  release();
  assert.equal((await first).status, 303);
  const page = await request(server, { path: '/setup', cookie });
  assert.match(page.body, /needs a 2FA code/);
});

// ---- status page, metrics -------------------------------------------------

test('status page and metrics show a vault waiting for its link', () => {
  const w = world();
  writeSyncStatus(syncStatusPath(w.cfg, 'plain'), { startedAt: 100, lastOutputAt: 100, lastFullySyncedAt: 0, lastLine: 'waiting for this vault to be linked: <b>', waiting: 'not-linked' });
  writeSyncStatus(syncStatusPath(w.cfg, 'secret'), { startedAt: 100, lastOutputAt: 200, lastFullySyncedAt: 200, lastLine: 'Fully synced' });
  const page = renderPage(w.cfg, { startedAt: 1, lastPassAt: 1, vaults: new Map() }, 300);
  assert.match(page, /not linked yet<\/span>; its container is waiting for a link\. Link it from the <a href="\/setup">setup page/);
  assert.match(page, /&lt;b&gt;/);
  const m = renderMetrics(w.cfg, { startedAt: 1, lastPassAt: 1, vaults: new Map() });
  assert.match(m, /obsidian_headless_sync_linked\{vault="plain"\} 0/);
  assert.match(m, /obsidian_headless_sync_linked\{vault="secret"\} 1/);
  // A vault that never links keeps its start time as the stale-alert baseline.
  assert.match(m, /obsidian_headless_sync_last_fully_synced_timestamp_seconds\{vault="plain"\} 100/);
});

// ---- prepare and sync, as processes ---------------------------------------

function runPrepare(w, env = {}) {
  return spawnSync('node', [path.join(APP, 'bin', 'prepare.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, ...w.env, OBSIDIAN_HEADLESS_CONFIG: w.configFile, OBSIDIAN_AUTH_TOKEN: '', ...env },
  });
}

test('prepare, wizard mode: nobody logged in skips linking and succeeds', () => {
  const w = world();
  const r = runPrepare(w);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plain: not linked, and nobody has logged in yet/);
  assert.match(r.stdout, /ready: 0 of 2 vault\(s\) linked/);
  assert.doesNotMatch(w.readLog('argv.log'), /sync-setup|sync-config/);
});

test('prepare, wizard mode: links what it can, skips an E2E vault with no password', () => {
  const w = world();
  w.login();
  const r = runPrepare(w);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /secret: not linked \(remote vault "Secret" is end-to-end encrypted/);
  assert.match(r.stdout, /ready: 1 of 2 vault\(s\) linked/);
  const configs = w.readLog('config.log');
  assert.match(configs, /vaults\/plain/);
  assert.doesNotMatch(configs, /vaults\/secret/);
});

test('prepare, wizard mode: a directory linked to another remote still stops the pod', () => {
  const w = world({ links: { plain: { vaultId: 'id-x', vaultName: 'Elsewhere' } } });
  const r = runPrepare(w);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plain: .* is linked to remote vault "Elsewhere"/);
});

test('prepare, Secret mode: unchanged contract, E2E password on stdin', () => {
  const w = world({ authMode: 'secret', vaults: [{ name: 'secret', remote: 'Secret', encrypted: true }] });
  const missing = runPrepare(w);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /OBSIDIAN_AUTH_TOKEN is not set/);
  const noPw = runPrepare(w, { OBSIDIAN_AUTH_TOKEN: 'tok' });
  assert.equal(noPw.status, 1);
  assert.match(noPw.stderr, /VAULT_0_PASSWORD is empty/);
  const bad = runPrepare(w, { OBSIDIAN_AUTH_TOKEN: 'tok', VAULT_0_PASSWORD: 'wrong' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /was not accepted/);
  const ok = runPrepare(w, { OBSIDIAN_AUTH_TOKEN: 'tok', VAULT_0_PASSWORD: 'e2e-pw' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /ready: 1 vault\(s\)/);
  assert.ok(!w.readLog('argv.log').includes('e2e-pw'), 'E2E password reached argv');
  assert.match(w.readLog('stdin.log'), /"e2e-pw"/);
});

test('prepare, Secret mode: an unlinked vault the client says needs a password fails the pod', () => {
  const w = world({ authMode: 'secret', vaults: [{ name: 'secret', remote: 'Secret' }] });
  const r = runPrepare(w, { OBSIDIAN_AUTH_TOKEN: 'tok' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /end-to-end encrypted and needs its password/);
});

function waitFor(fn, ms = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v) resolve(v);
      else if (Date.now() - start > ms) reject(new Error('timed out waiting'));
      else setTimeout(tick, 25);
    };
    tick();
  });
}

function startSync(w, name) {
  const child = spawn('node', [path.join(APP, 'bin', 'sync.mjs'), name], {
    env: { ...process.env, ...w.env, OBSIDIAN_HEADLESS_CONFIG: w.configFile, OHS_LINK_POLL_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  return { child, exited, output: () => out };
}

test('sync waits for its link, heartbeating, then starts the client', async () => {
  const w = world();
  w.login();
  const file = syncStatusPath(w.cfg, 'plain');
  const s = startSync(w, 'plain');
  try {
    const waiting = await waitFor(() => {
      const st = readSyncStatus(file);
      return st && st.waiting === 'not-linked' ? st : null;
    });
    assert.match(waiting.lastLine, /No sync configuration found/);
    const m1 = fs.statSync(file).mtimeMs;
    await waitFor(() => fs.statSync(file).mtimeMs > m1);
    assert.match(s.output(), /not linked yet .*; waiting/);
    assert.equal((s.output().match(/not linked yet/g) || []).length, 1, 'logs once per reason, not every poll');

    const links = path.join(w.env.FAKE_OB_DIR, 'links.json');
    fs.writeFileSync(links, JSON.stringify({ [w.cfg.vaults[0].dir]: { vaultId: 'id-plain', vaultName: 'Plain' } }));
    const synced = await waitFor(() => {
      const st = readSyncStatus(file);
      return st && st.lastFullySyncedAt ? st : null;
    });
    assert.equal(synced.waiting, undefined);
    assert.match(s.output(), /linked; starting the client/);
  } finally {
    s.child.kill('SIGTERM');
  }
  assert.deepEqual(await s.exited, { code: 0, signal: null });
});

test('sync stops cleanly while still waiting', async () => {
  const w = world();
  const s = startSync(w, 'plain');
  await waitFor(() => readSyncStatus(syncStatusPath(w.cfg, 'plain')));
  s.child.kill('SIGTERM');
  assert.deepEqual(await s.exited, { code: 0, signal: null });
});
