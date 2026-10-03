// Renders <vault>/VAULT-STATUS.md: a note that syncs to every device, so drift
// (a parked branch, a stray device edit, a stopped keeper) is visible from the
// phone without cluster access.

import fs from 'node:fs';
import path from 'node:path';
import { isTracked } from './keeper.mjs';

export const LIST_LIMIT = 20;

export function formatTime(epochSeconds, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(new Date(epochSeconds * 1000)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

function mdList(items) {
  const out = items.slice(0, LIST_LIMIT).map((f) => `- \`${f}\``);
  if (items.length > LIST_LIMIT) out.push(`- ...and ${items.length - LIST_LIMIT} more`);
  return out;
}

export function fixHint(r, cfg) {
  const p = cfg.fixCommand ? `${cfg.fixCommand} ` : '';
  const d = r.defaultBranch;
  const g = `${p}git -C ${r.dir}`;
  switch (r.state) {
    case 'NOT-A-REPO': return 'the vault directory is not a git clone. Delete it and restart the pod to re-clone.';
    case 'FETCH-FAILED': return `check network and credentials with \`${g} fetch origin\``;
    case 'OFF-BRANCH': return `\`${g} checkout ${d}\` (the vault only follows ${d})`;
    case 'DIRTY': return `review with \`${g} status\`; move the edit into a branch and PR, discard it, or add the path to discardLocalChanges`;
    case 'DIVERGED': return `push the local commits to a branch (\`${g} log --oneline origin/${d}..HEAD\`), then \`${g} reset --keep origin/${d}\``;
    case 'FF-FAILED': return `run \`${g} merge --ff-only origin/${d}\` to see what blocks it (often an untracked file in the way)`;
    default: return '';
  }
}

export function renderStatus(r, cfg, nowEpoch = Date.now() / 1000) {
  const lines = ['# Vault status', ''];
  lines.push(`Last checked: ${formatTime(nowEpoch, cfg.timezone)} by ${cfg.deviceName}`, '');
  lines.push(`- State: **${r.state}**`);
  if (r.branch) lines.push(`- Branch: \`${r.branch}\` (follows \`${r.defaultBranch}\`)`);
  if (r.head) lines.push(`- HEAD: \`${r.head}\` ${r.subject} (${formatTime(r.commitEpoch, cfg.timezone)})`);
  if (r.behind !== null && r.behind !== undefined) lines.push(`- Behind origin/${r.defaultBranch}: ${r.behind}`);
  if (r.detail) lines.push(`- Detail: ${r.detail}`);
  if (r.discarded.length) {
    lines.push('', 'Restored from git (these paths are listed in discardLocalChanges):', '', ...mdList(r.discarded));
  }
  if (r.dirty.length) {
    lines.push('', 'Changed tracked files (an edit reached this clone):', '', ...mdList(r.dirty));
  }
  if (r.untracked.length) {
    lines.push('', 'Untracked, possibly a device edit or a Sync conflict file:', '', ...mdList(r.untracked));
  }
  if (r.state !== 'OK') {
    lines.push('', `Fix: ${fixHint(r, cfg)}`);
  }
  const staleMinutes = Math.round((cfg.intervalSeconds * 3) / 60);
  lines.push('', `If Last checked is more than about ${staleMinutes} minutes old, the vault keeper has stopped.`, '');
  return lines.join('\n');
}

// Returns a warning string instead of writing when the status file is tracked:
// writing it would leave the clone permanently DIRTY.
export function writeStatus(r, cfg) {
  if (!cfg.statusFile || r.state === 'NOT-A-REPO') return null;
  if (isTracked(r.dir, cfg.statusFile)) {
    return `${cfg.statusFile} is tracked in ${r.dir}; not writing it (untrack and gitignore it)`;
  }
  const target = path.join(r.dir, cfg.statusFile);
  // A dotfile temp name: Obsidian Sync ignores dotfiles, so it never uploads it.
  const tmp = path.join(r.dir, `.${cfg.statusFile}.tmp.${process.pid}`);
  try {
    fs.writeFileSync(tmp, renderStatus(r, cfg));
    fs.renameSync(tmp, target);
    return null;
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    return `could not write ${target}: ${err.message}`;
  }
}
