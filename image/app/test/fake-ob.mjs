#!/usr/bin/env node
// A stand-in for the Obsidian headless client, for tests. It reproduces the
// behaviors of obsidian-headless@0.0.14 the runtime depends on: exit codes,
// the error lines it prints, prompts that read stdin to EOF when stdin is not a
// TTY, and `ob login` revoking the existing token before it logs in.
//
// State lives in $FAKE_OB_DIR:
//   account.json  { password, mfa }      the account login accepts
//   remote.json   { vaults, shared }     remote vaults; { id, name, e2e } each,
//                                        e2e being that vault's password
//   links.json    { "<path>": { vaultId, vaultName } }
//   argv.log      one JSON argv per invocation
//   config.log    one JSON argv per sync-config
//   stdin.log     one JSON-quoted stdin per invocation that read it
//
// node --test treats every file under test/ as a test file, so with no command
// this exits 0 and does nothing.

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
if (!args.length) process.exit(0);

const dir = process.env.FAKE_OB_DIR;
const file = (n) => path.join(dir, n);
const read = (n, d) => { try { return JSON.parse(fs.readFileSync(file(n), 'utf8')); } catch { return d; } };
const write = (n, v) => fs.writeFileSync(file(n), JSON.stringify(v));
fs.appendFileSync(file('argv.log'), `${JSON.stringify(args)}\n`);

const tokenFile = path.join(process.env.XDG_CONFIG_HOME, 'obsidian-headless', 'auth_token');
const token = () => process.env.OBSIDIAN_AUTH_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : null);

function opt(name) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}
function stdin() {
  const s = fs.readFileSync(0, 'utf8');
  fs.appendFileSync(file('stdin.log'), `${JSON.stringify(s)}\n`);
  return s.trimEnd();
}
function die(code, ...lines) {
  for (const l of lines) process.stderr.write(`${l}\n`);
  process.exit(code);
}
function needToken() {
  if (!token()) die(2, 'No account logged in. Run "ob login" first.');
}

const cmd = args[0];
if (cmd === '--version') {
  process.stdout.write('0.0.14\n');
} else if (cmd === 'login') {
  if (token()) fs.rmSync(tokenFile, { force: true });
  const acct = read('account.json', { password: 'pw' });
  const email = opt('email');
  const password = opt('password') || stdin();
  if (password !== acct.password) {
    die(2, 'Login failed: s [Error]: Login failed, incorrect email or password.', '    at z (cli.js:141:832)');
  }
  const mfa = opt('mfa') || '';
  if (acct.mfa && !mfa) process.exit(0); // re-prompts on a closed stdin; the real client exits 0 silently
  if (acct.mfa && mfa !== acct.mfa) die(2, 'Login failed: s [Error]: 2FA code is incorrect', '    at z (cli.js:141:832)');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, 'tok', { mode: 0o600 });
  process.stdout.write(`Logged in as Test User (${email})\n`);
} else if (cmd === 'sync-list-remote') {
  needToken();
  const r = read('remote.json', { vaults: [], shared: [] });
  const strip = (v) => ({ id: v.id, name: v.name, region: 'us' });
  process.stdout.write(JSON.stringify({ vaults: r.vaults.map(strip), shared: (r.shared || []).map(strip) }, null, 2));
} else if (cmd === 'sync-status') {
  const p = path.resolve(opt('path'));
  const l = read('links.json', {})[p];
  if (!l) die(3, `No sync configuration found for ${p}`);
  process.stdout.write(JSON.stringify({ ...l, vaultPath: p }, null, 2));
} else if (cmd === 'sync-setup') {
  needToken();
  const want = opt('vault');
  const p = path.resolve(opt('path'));
  const r = read('remote.json', { vaults: [], shared: [] });
  const all = [...r.vaults, ...(r.shared || [])];
  let v = all.find((x) => x.id === want);
  if (!v) {
    const named = all.filter((x) => x.name === want);
    if (named.length > 1) die(1, `Multiple vaults named "${want}". Use the vault ID instead:`, ...named.map((x) => `  ${x.id}  "${x.name}"`));
    [v] = named;
  }
  if (!v) die(3, `Vault "${want}" not found.`);
  process.stdout.write('Fetching vault info...\n');
  if (v.e2e) {
    const pw = opt('password') || stdin();
    if (!pw) die(2, 'Password not provided.');
    if (pw !== v.e2e) die(2, 'Failed to validate password. s [Error]: bad key');
  }
  const links = read('links.json', {});
  links[p] = { vaultId: v.id, vaultName: v.name };
  write('links.json', links);
  fs.mkdirSync(p, { recursive: true });
  process.stdout.write('\nVault configured successfully!\n');
} else if (cmd === 'sync-config') {
  const p = path.resolve(opt('path'));
  if (!read('links.json', {})[p]) die(3, `No sync configuration found for ${p}`);
  fs.appendFileSync(file('config.log'), `${JSON.stringify(args)}\n`);
  process.stdout.write('{}\n');
} else if (cmd === 'sync') {
  const p = path.resolve(opt('path'));
  if (!read('links.json', {})[p]) die(3, `No sync configuration found for ${p}`, "Run 'ob sync-setup' first.");
  needToken();
  process.stdout.write('Fully synced\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
} else {
  die(1, `fake ob: unknown command ${cmd}`);
}
