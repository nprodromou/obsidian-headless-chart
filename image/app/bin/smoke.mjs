#!/usr/bin/env node
// Image smoke test, run by CI against the built image after
// `prepare.mjs --install-only`: the installed client starts, and its native
// SQLite binding loads on this architecture.

import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../lib/config.mjs';
import { clientDir, obVersion } from '../lib/ob.mjs';

const cfg = loadConfig();
process.stdout.write(`ob ${obVersion(cfg)}\n`);

const require = createRequire(path.join(clientDir(cfg), 'node_modules', 'obsidian-headless', 'cli.js'));
const Database = require('better-sqlite3');
const db = new Database(':memory:');
const row = db.prepare('select sqlite_version() as v').get();
process.stdout.write(`better-sqlite3 ok (sqlite ${row.v})\n`);
db.close();
