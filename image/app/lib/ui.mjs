// Read-only HTML status page, served on the keeper's UI listener.
//
// Everything interpolated into the page comes from vault content or the sync
// client (file names, log lines, commit subjects), so every value goes through
// html() and the page carries no script. The listener is loopback-only by
// default; the Host allowlist stops a page on another origin reading it through
// an open port-forward (DNS rebinding).

import { readSyncStatus, syncStatusPath } from './syncstatus.mjs';
import { fixHint, formatTime, LIST_LIMIT } from './status.mjs';

export const REFRESH_SECONDS = 30;

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const BUILTIN_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

// The host part of a Host header, lowercased, without the port. IPv6 keeps its
// brackets. Returns '' for anything that isn't a plain host[:port].
export function hostOf(header) {
  const h = String(header || '').trim().toLowerCase();
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]\s/]+)(?::(\d{1,5}))?$/.exec(h);
  return m ? m[1] : '';
}

export function hostAllowed(header, allowedHosts = []) {
  const host = hostOf(header);
  return Boolean(host) && (BUILTIN_HOSTS.includes(host) || allowedHosts.includes(host));
}

function ago(seconds) {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function when(epoch, cfg, now) {
  if (!epoch) return 'never';
  return `${html(formatTime(epoch, cfg.timezone))} (${ago(now - epoch)})`;
}

function list(title, items) {
  if (!items || !items.length) return '';
  const shown = items.slice(0, LIST_LIMIT).map((f) => `<li><code>${html(f)}</code></li>`);
  if (items.length > LIST_LIMIT) shown.push(`<li>...and ${items.length - LIST_LIMIT} more</li>`);
  return `<p>${html(title)}</p><ul>${shown.join('')}</ul>`;
}

function row(label, value) {
  return `<tr><th>${html(label)}</th><td>${value}</td></tr>`;
}

function syncSection(cfg, vault, now) {
  const s = readSyncStatus(syncStatusPath(cfg, vault.name));
  if (!s) return '<p>Sync client: no status yet (the container has not started, or has not written its first status).</p>';
  return `<table>${[
    row('Client started', when(s.startedAt, cfg, now)),
    row('Last "Fully synced"', when(s.lastFullySyncedAt, cfg, now)),
    row('Last output', when(s.lastOutputAt, cfg, now)),
    row('Last line', s.lastLine ? `<code>${html(s.lastLine)}</code>` : '-'),
  ].join('')}</table>`;
}

function gitSection(cfg, vault, keeperState, now) {
  const entry = keeperState.vaults.get(vault.name);
  if (!entry) {
    const why = keeperState.lastPassAt
      ? 'no result from the last pass; the keeper logged an error for this vault'
      : 'pending: the keeper has not finished its first pass';
    return `<p class="git">Git: <span class="state pending">${html(why)}</span></p>`;
  }
  const r = entry.result;
  const rows = [
    row('State', `<span class="state ${r.state === 'OK' ? 'ok' : 'bad'}">${html(r.state)}</span> since ${when(entry.stateSince, cfg, now)}`),
  ];
  if (r.branch) rows.push(row('Branch', `<code>${html(r.branch)}</code> (follows <code>${html(r.defaultBranch)}</code>)`));
  if (r.head) rows.push(row('HEAD', `<code>${html(r.head)}</code> ${html(r.subject)} (${html(formatTime(r.commitEpoch, cfg.timezone))})`));
  if (r.behind !== null && r.behind !== undefined) rows.push(row(`Behind origin/${r.defaultBranch}`, html(r.behind)));
  if (r.detail) rows.push(row('Detail', html(r.detail)));
  const fix = r.state === 'OK' ? '' : `<p>Fix: ${html(fixHint(r, cfg))}</p>`;
  return `<table>${rows.join('')}</table>`
    + list('Restored from git (listed in discardLocalChanges):', r.discarded)
    + list('Changed tracked files (an edit reached this clone):', r.dirty)
    + list('Untracked, possibly a device edit or a Sync conflict file:', r.untracked)
    + fix;
}

// keeperState: { startedAt, lastPassAt, vaults: Map(name -> { result, stateSince, discardedTotal }) }
export function renderPage(cfg, keeperState, now = Math.floor(Date.now() / 1000)) {
  const vaults = cfg.vaults.map((v) => `<section><h2>${html(v.name)}</h2>`
    + `<p class="remote">Remote: ${html(v.remote)}${v.git ? ' &middot; git-backed' : ''}</p>`
    + syncSection(cfg, v, now)
    + (v.git ? gitSection(cfg, v, keeperState, now) : '')
    + '</section>');
  const gitCount = cfg.vaults.filter((v) => v.git).length;
  const keeper = gitCount
    ? `Keeper started ${when(keeperState.startedAt, cfg, now)}; last pass ${when(keeperState.lastPassAt, cfg, now)}; `
      + `${gitCount} git-backed vault(s) every ${html(cfg.intervalSeconds)}s.`
    : `Keeper started ${when(keeperState.startedAt, cfg, now)}; no git-backed vaults.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${REFRESH_SECONDS}">
<title>${html(cfg.deviceName)} &middot; obsidian-headless-sync</title>
<style>
body { font: 15px/1.45 system-ui, sans-serif; max-width: 60rem; margin: 1.5rem auto; padding: 0 1rem; color: #222; }
h1 { font-size: 1.3rem; } h2 { font-size: 1.1rem; margin-bottom: .2rem; }
section { border-top: 1px solid #ddd; padding: .5rem 0 1rem; }
table { border-collapse: collapse; } th { text-align: left; font-weight: 600; padding: .1rem 1rem .1rem 0; vertical-align: top; }
code { font-size: .9em; word-break: break-all; } .remote, .meta { color: #666; }
.state { font-weight: 700; } .ok { color: #176f2c; } .bad { color: #b3261e; } .pending { color: #8a6d00; }
</style>
</head>
<body>
<h1>${html(cfg.deviceName)}</h1>
<p class="meta">${keeper} Checked ${html(formatTime(now, cfg.timezone))}; this page refreshes every ${REFRESH_SECONDS}s.</p>
${vaults.join('\n')}
</body>
</html>
`;
}
