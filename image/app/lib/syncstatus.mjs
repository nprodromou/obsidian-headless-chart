// Per-vault sync status, written by the sync supervisor into a shared emptyDir
// and read by the keeper's metrics endpoint. The file's mtime doubles as the
// sync container's liveness heartbeat.

import fs from 'node:fs';
import path from 'node:path';

export function syncStatusPath(cfg, name) {
  return path.join(cfg.statusDir, `sync-${name}.json`);
}

export function writeSyncStatus(file, status) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status));
  fs.renameSync(tmp, file);
}

export function readSyncStatus(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ob logs "Fully synced" at the end of every pass that found nothing left to
// do; in continuous mode a pass runs at least every 30 seconds.
export const FULLY_SYNCED = /Fully synced/;
