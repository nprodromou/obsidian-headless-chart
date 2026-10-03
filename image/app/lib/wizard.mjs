// Browser setup wizard: log in to Obsidian and link the vaults values declare.
//
// Served on the UI listener under /setup, and only in wizard mode (no auth
// Secret configured). In Secret mode these routes don't exist: `ob login`
// revokes whatever token it finds first, so a browser login there would kill
// the Secret's token for every container (docs/proposals/web-ui.md, decision 2).
//
// Whoever drives this page can act as the account owner, so on top of the
// listener's Host allowlist:
//   - every route needs a session, which takes the setup code from the keeper's
//     log (128 random bits, new on each keeper start);
//   - every POST needs that session cookie (HttpOnly, SameSite=Strict) and an
//     Origin header naming this same host;
//   - passwords reach `ob` on stdin, never argv, and nothing logs an action's
//     arguments or input.
// Actions run one at a time, as async children with a timeout, so the status
// page and /metrics keep answering while the client works.

import crypto from 'node:crypto';
import { html, layout, SECURITY_HEADERS } from './ui.mjs';
import { applySyncConfig, linkStatus, setupLink } from './link.mjs';
import { firstLine } from './proc.mjs';

export const COOKIE = 'ohs_setup';
// `ob login` needing a 2FA code it wasn't given re-prompts on a closed stdin.
// The pinned client then exits 0 having printed nothing; a client that waits
// instead is cut off here. Either way it reads as "needs a 2FA code".
export const LOGIN_TIMEOUT_MS = 30000;
const ACTION_TIMEOUT_MS = 90000;
const MAX_BODY = 16 * 1024;
const MAX_SESSIONS = 16;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,128}$/;
const MFA = /^\d{6,8}$/;

export function newSetupCode() {
  return crypto.randomBytes(16).toString('hex');
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// The Origin a browser sends on a form POST must name the host it posted to.
// Missing, "null" or foreign means another page is driving this one.
export function sameOrigin(origin, host) {
  let u;
  try {
    u = new URL(String(origin));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = String(host || '').toLowerCase();
  const defaultPort = u.protocol === 'http:' ? '80' : '443';
  return u.host === h || (u.port === '' && h === `${u.hostname}:${defaultPort}`);
}

// A values-file name for a remote vault: what the chart's vault name pattern
// accepts, unique among the names already taken.
export function slugFor(name, taken) {
  let base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    .replace(/-+$/, '');
  if (!base) base = 'vault';
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base.slice(0, 38)}-${n}`;
  taken.add(slug);
  return slug;
}

// Remote vaults that no declared vault points at, as the values entries to add.
// The name is used where it is unique on the account, the ID where it isn't.
export function valuesSnippet(cfg, remote) {
  const all = [...(remote.vaults || []), ...(remote.shared || [])];
  const declared = (r) => cfg.vaults.some((v) => v.remote === r.id || v.remote === r.name);
  const missing = all.filter((r) => !declared(r));
  if (!missing.length) return '';
  const taken = new Set(cfg.vaults.map((v) => v.name));
  const lines = ['vaults:'];
  for (const r of missing) {
    const unique = all.filter((x) => x.name === r.name).length === 1;
    lines.push(`  - name: ${slugFor(r.name, taken)}`);
    lines.push(`    remote: ${JSON.stringify(unique ? r.name : r.id)}${unique ? '' : `  # ${JSON.stringify(r.name)}`}`);
  }
  return lines.join('\n');
}

// "Login failed: s [Error]: Login failed, incorrect email or password." plus a
// stack trace becomes "incorrect email or password." style first-line text.
function loginError(res) {
  const line = firstLine(res.stderr) || firstLine(res.stdout) || `exit ${res.status}`;
  return line.replace(/^Login failed:\s*/, '').replace(/^\S+ \[Error\]:\s*/, '').slice(0, 300);
}

// exec(args, { input, timeoutMs }) runs ob; hasToken() reports whether the token
// file exists. Both are injected so tests can drive the wizard with a fake client.
export function createWizard(cfg, { exec, hasToken, code = newSetupCode(), log = () => {} }) {
  const sessions = [];
  const flash = new Map();
  let busy = false;
  let account = '';
  let remote = null;
  const links = new Map();
  const pending = new Map();
  const run = (args, opts = {}) => exec(args, { timeoutMs: ACTION_TIMEOUT_MS, ...opts });

  function sessionOf(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return token && sessions.find((s) => sameSecret(s, token)) ? token : null;
  }

  function send(res, status, body, extra = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8', ...extra });
    res.end(body);
  }

  function redirect(res, extra = {}) {
    res.writeHead(303, { ...SECURITY_HEADERS, Location: '/setup', ...extra });
    res.end();
  }

  function page(title, body) {
    return layout(`${html(title)} &middot; obsidian-headless-sync`,
      `<h1>${html(title)}</h1>\n<p class="meta"><a href="/">Status</a></p>\n${body}`);
  }

  function message(kind, text) {
    return `<p class="flash ${kind}">${html(text)}</p>`;
  }

  function codePage(error = '') {
    return page('Setup', `${error ? message('bad', error) : ''}
<p>Enter the setup code from the keeper's log. It is printed once each time the keeper starts:</p>
<pre>${html(cfg.fixCommand ? cfg.fixCommand.replace(/ exec /, ' logs ').replace(/ --$/, '') : 'kubectl logs deploy/<release> -c keeper')} | grep 'setup code'</pre>
<form method="post" action="/setup/code">
<label>Setup code <input type="password" name="code" autocomplete="off" required></label>
<button type="submit">Continue</button>
</form>`);
  }

  function vaultRow(vault) {
    const st = links.get(vault.name);
    const p = pending.get(vault.name);
    let status;
    let action = '';
    if (!st) status = 'not checked';
    else if (st.state === 'linked') status = `<span class="state ok">linked</span> to ${html(st.vaultName)} (<code>${html(st.vaultId)}</code>)`;
    else if (st.state === 'mismatch') status = `<span class="state bad">linked elsewhere</span>: ${html(st.message)}`;
    else if (st.state === 'unlinked') status = `<span class="state pending">${html(st.reason)}</span>`;
    else status = `<span class="state bad">unknown</span>: ${html(st.message)}`;

    const linkable = !st || st.state === 'unlinked' || st.state === 'error';
    if (linkable && p && (p.reason === 'needs-password' || p.reason === 'bad-password')) {
      action = `<form method="post" action="/setup/link">
<input type="hidden" name="vault" value="${html(vault.name)}">
<label>End-to-end encryption password <input type="password" name="password" autocomplete="off" required></label>
<button type="submit">Link</button>
</form>`;
    } else if (linkable && p && p.reason === 'ambiguous') {
      const ids = p.candidates.map((c) => `<li><code>${html(c.id)}</code> ${html(c.name)}</li>`).join('');
      action = `<p>More than one remote vault is named ${html(vault.remote)}. Set this vault's <code>remote</code> to one of these IDs in your values and roll out again:</p><ul>${ids}</ul>`
        + (p.candidates[0] ? `<pre>${html(`  - name: ${vault.name}\n    remote: ${JSON.stringify(p.candidates[0].id)}`)}</pre>` : '');
    } else if (linkable) {
      action = `<form method="post" action="/setup/link">
<input type="hidden" name="vault" value="${html(vault.name)}">
<button type="submit">Link</button>
</form>`;
    }
    const note = p && linkable ? `<br>${html(p.message)}` : '';
    return `<tr><th>${html(vault.name)}</th><td>${html(vault.remote)}</td><td>${status}${note}</td><td>${action}</td></tr>`;
  }

  function wizardPage(session) {
    const f = flash.get(session);
    flash.delete(session);
    const loggedIn = hasToken();
    const who = loggedIn
      ? `<p>Logged in${account ? `: ${html(account)}` : ' (a token file is present)'}.</p>
<p class="meta">Logging in again signs the current token out first, and the sync containers restart with the new one.
If the new login fails, the pod stays logged out until one succeeds.</p>`
      : '<p><strong>Not logged in.</strong></p>';
    const login = `<form method="post" action="/setup/login">
<label>Email <input type="email" name="email" autocomplete="username" required></label>
<label>Password <input type="password" name="password" autocomplete="current-password" required></label>
<label>2FA code <input type="text" name="mfa" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,8}"> (if the account has one)</label>
<button type="submit">${loggedIn ? 'Log in again' : 'Log in'}</button>
</form>`;
    let vaults = '';
    if (loggedIn) {
      const rows = cfg.vaults.map(vaultRow).join('');
      const snippet = remote && !remote.error ? valuesSnippet(cfg, remote) : '';
      const extra = !remote ? '<p>Check vaults to list the account\'s remote vaults.</p>'
        : remote.error ? message('bad', `Could not list remote vaults: ${remote.error}`)
          : snippet
            ? `<p>Remote vaults on this account that no vault in your values points at. To sync them, add these entries to <code>vaults</code> and roll out again (an end-to-end encrypted one then asks for its password here):</p><pre>${html(snippet)}</pre>`
            : '<p>Every remote vault on this account is declared in your values.</p>';
      vaults = `<section><h2>Vaults</h2>
<p>The vaults your values declare. A linked vault's sync container starts within ten seconds.</p>
<table><tr><th>Name</th><th>Remote</th><th>Status</th><th></th></tr>${rows}</table>
<form method="post" action="/setup/refresh"><button type="submit">Check vaults</button></form>
${extra}
</section>`;
    }
    return page('Setup', `${f ? message(f.kind, f.text) : ''}
<section><h2>Obsidian account</h2>
${who}
${login}
</section>
${vaults}`);
  }

  async function refresh() {
    const list = await run(['sync-list-remote', '--json']);
    if (list.ok) {
      try {
        const parsed = JSON.parse(list.stdout);
        remote = { vaults: parsed.vaults || [], shared: parsed.shared || [] };
      } catch {
        remote = { error: 'could not parse ob sync-list-remote output' };
      }
    } else {
      remote = { error: firstLine(list.stderr) || (list.timedOut ? 'timed out' : `exit ${list.status}`) };
    }
    for (const vault of cfg.vaults) links.set(vault.name, await linkStatus(vault, run));
  }

  async function doLogin(form) {
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    const mfa = String(form.get('mfa') || '').trim();
    if (!EMAIL.test(email)) return { kind: 'bad', text: 'Enter the email address of the Obsidian account.' };
    if (!password) return { kind: 'bad', text: 'Enter the account password.' };
    if (mfa && !MFA.test(mfa)) return { kind: 'bad', text: 'A 2FA code is 6 to 8 digits.' };
    // `--opt=value` so nothing the form sends can be read as another option.
    const args = ['login', `--email=${email}`];
    if (mfa) args.push(`--mfa=${mfa}`);
    const res = await exec(args, { input: password, timeoutMs: LOGIN_TIMEOUT_MS });
    const ok = res.ok && /Logged in as /.test(res.stdout);
    if (ok) {
      account = firstLine(res.stdout.slice(res.stdout.indexOf('Logged in as '))).replace(/^Logged in as /, '').slice(0, 200);
      log('setup: login succeeded');
      pending.clear();
      await refresh();
      return { kind: 'ok', text: `Logged in as ${account}.` };
    }
    account = '';
    log('setup: login failed');
    if ((res.ok || res.timedOut) && !mfa) {
      return { kind: 'bad', text: 'This account needs a 2FA code. Enter it with your email and password.' };
    }
    if (res.timedOut) return { kind: 'bad', text: 'Login timed out.' };
    return { kind: 'bad', text: `Login failed: ${loginError(res)}` };
  }

  async function doLink(form) {
    const name = String(form.get('vault') || '');
    const vault = cfg.vaults.find((v) => v.name === name);
    if (!vault) return { kind: 'bad', text: 'No such vault in your values.' };
    if (!hasToken()) return { kind: 'bad', text: 'Log in first.' };
    // Same refusal as the init container: never re-link a directory that points
    // at a different remote.
    const st = await linkStatus(vault, run);
    links.set(vault.name, st);
    if (st.state === 'linked') {
      pending.delete(vault.name);
      return { kind: 'ok', text: `${vault.name} is already linked.` };
    }
    if (st.state === 'mismatch') return { kind: 'bad', text: `${vault.name}: ${st.message}` };
    const password = form.has('password') ? String(form.get('password')) : '';
    const res = await setupLink(vault, cfg, run, password);
    if (!res.ok) {
      log(`setup: ${vault.name}: not linked (${res.reason})`);
      pending.set(vault.name, res);
      return { kind: 'bad', text: `${vault.name}: ${res.message}` };
    }
    pending.delete(vault.name);
    log(`setup: ${vault.name}: linked`);
    const conf = await applySyncConfig(vault, cfg, run);
    links.set(vault.name, await linkStatus(vault, run));
    if (!conf.ok) {
      log(`setup: ${vault.name}: ${conf.message}`);
      return { kind: 'bad', text: `${vault.name} is linked, but applying its sync settings failed (${conf.message}). Restart the pod to apply them.` };
    }
    return { kind: 'ok', text: `Linked ${vault.name}; ${conf.message}. Its sync container starts within ten seconds.` };
  }

  async function doRefresh() {
    if (!hasToken()) return { kind: 'bad', text: 'Log in first.' };
    await refresh();
    return null;
  }

  function readForm(req) {
    return new Promise((resolve, reject) => {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/x-www-form-urlencoded') {
        reject(Object.assign(new Error('unsupported content type'), { status: 415 }));
        return;
      }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(Object.assign(new Error('request body too large'), { status: 413 }));
          req.destroy();
        } else {
          chunks.push(c);
        }
      });
      req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }

  const ACTIONS = { '/setup/login': doLogin, '/setup/link': doLink, '/setup/refresh': doRefresh };

  async function handle(req, res, path) {
    const session = sessionOf(req);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path !== '/setup') return send(res, 404, page('Not found', ''));
      const body = session ? wizardPage(session) : codePage();
      return send(res, 200, req.method === 'HEAD' ? undefined : body);
    }
    if (req.method !== 'POST') return send(res, 405, page('Method not allowed', ''), { Allow: 'GET, HEAD, POST' });
    if (path !== '/setup/code' && !ACTIONS[path]) return send(res, 404, page('Not found', ''));
    if (!sameOrigin(req.headers.origin, req.headers.host)) {
      return send(res, 403, page('Refused', message('bad', 'Cross-origin request refused.')));
    }
    let form;
    try {
      form = await readForm(req);
    } catch (err) {
      return send(res, err.status || 400, page('Bad request', message('bad', err.message)));
    }

    if (path === '/setup/code') {
      if (!sameSecret(String(form.get('code') || '').trim(), code)) {
        log('setup: wrong setup code entered');
        return send(res, 403, codePage('That is not the current setup code.'));
      }
      const token = crypto.randomBytes(32).toString('hex');
      sessions.push(token);
      if (sessions.length > MAX_SESSIONS) sessions.shift();
      log('setup: setup code accepted; session started');
      return redirect(res, { 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
    }

    if (!session) return send(res, 403, codePage('Your setup session has ended. Enter the setup code again.'));
    if (busy) return send(res, 409, page('Busy', message('bad', 'Another setup action is still running. Go back and try again in a moment.')));
    busy = true;
    try {
      const result = await ACTIONS[path](form);
      if (result) flash.set(session, result);
    } finally {
      busy = false;
    }
    return redirect(res);
  }

  return { code, handle };
}
