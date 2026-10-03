# Design

## The problem

Obsidian Sync only moves files when an Obsidian client is running. For vaults whose content comes
from somewhere other than a person typing (a git repository, generated reports, a nightly job),
that client ends up being a desktop machine that has to stay awake. When it sleeps, every device
goes stale, and nothing says so.

In February 2026 Obsidian released an official headless client, `ob`. This chart runs it on
Kubernetes, and adds the one piece that pattern needs beyond plain sync: a keeper that holds a git
clone at its remote's default branch.

## Shape

One Deployment, one replica, `Recreate` strategy, one PersistentVolumeClaim.

```
Pod
├── init: prepare      install client → clone git vaults → link vaults to remotes
├── keeper             fast-forward git vaults every N seconds; /metrics, /healthz; status page
├── sync-<vault-a>     ob sync --continuous (supervised)
└── sync-<vault-b>     ...

/data                       PVC
├── .ob/                    installed client, keyed by lockfile hash + Node ABI + arch
├── config/                 XDG_CONFIG_HOME: client auth fallback and per-vault sync state
└── vaults/<name>/          vault working trees (git clones for git-backed vaults)
/run/obsidian-headless      emptyDir: per-vault sync status, shared with the keeper
```

**One replica, always.** Two clients on the same vault directory would race on the same files and
the same state database, and two clients on the same remote from the same content would upload
every change twice. `Recreate` makes sure the old pod is gone before the new one starts.

**One container per vault.** `ob sync` handles one vault per process. Separate containers give
each vault its own restarts, logs, liveness probe and resource limits. A single container running
N processes would need its own supervisor and would restart every vault when one fails.

**All vaults share one init container.** A vault that can't be prepared (a bad password, a
missing repository) blocks the whole pod, not just that vault. That's deliberate: a
half-configured pod that looks healthy is harder to notice than one that fails to start and says
why in `kubectl logs -c prepare`.

**An existing clone has to match `git.repository`.** The PVC outlives values changes, so on every
start `prepare` compares the clone's `remote.origin.url` with the configured repository (ignoring
a trailing `/` or `.git`) and refuses to start on a mismatch. It doesn't rewrite `origin` itself:
if the new value names a different repository, the keeper would fast-forward a vault that Sync
has already uploaded onto unrelated files. When a repository genuinely moved, `git remote set-url`
in the clone is the fix; otherwise move the directory aside and let `prepare` clone it fresh.

## The client is installed at start, not bundled

The npm package `obsidian-headless` is published as `UNLICENSED`, and its repository has no
license file. So it can be used but not redistributed, and a public image that contained it would
be redistributing it. The published image contains Node, git and this repository's scripts. The
init container installs the client with `npm ci` from a lockfile committed here:

- The version is pinned, and npm verifies every package's integrity hash from the lockfile. A
  compromised upstream publish of the same version fails the install instead of running.
- The install lands on the data volume and is skipped on later starts while the lockfile hash,
  the Node ABI and the CPU architecture are unchanged. The last two matter because
  `better-sqlite3` is a native module.
- The cost is network access to `registry.npmjs.org` (and GitHub, for `better-sqlite3`'s prebuilt
  binary) on the first start and after each client bump.

For clusters without that egress, the Dockerfile takes `--build-arg BUNDLE_OB=true` to build a
private image with the client baked in (`obsidian.installClient: false`). That image must not be
published.

## Linking vaults

`prepare` checks `ob sync-status --path <dir> --json` for each vault:

- **Exit 0:** already linked. If it's linked to a different remote than configured, `prepare`
  fails rather than re-linking. Changing which remote a directory syncs with is a decision, and
  getting it wrong merges two vaults.
- **Exit 3** (no configuration) **or 2** (encryption key missing): runs `ob sync-setup`.
- **Anything else** fails the pod.

`ob sync-config` runs on every start, so edited sync values take effect on the next rollout.

The end-to-end encryption password is only needed by `sync-setup`, which derives the key and
stores it in the client's config on the data volume. The password reaches the client as a
`--password` argument, because with `--json` the client has no other non-interactive input. So
it's visible in the init container's process list while setup runs. Nothing else runs in that
container.

## Git-backed vaults

### Why the rules are this strict

The keeper runs fetch, a fast-forward-only merge, and, only for paths the operator declares
disposable, a restore from `HEAD`. It never commits, resets, stashes, cleans or switches branches.
A clone that has drifted is reported with the command that fixes it, and left alone. An automated
process that "repairs" a repository by discarding state it doesn't understand eventually discards
something that mattered.

States: `OK`, `DIRTY` (changed tracked files), `OFF-BRANCH`, `DIVERGED` (local commits),
`FF-FAILED`, `FETCH-FAILED`, `NOT-A-REPO`.

### `discardLocalChanges`

The strict rules have one failure mode, and it shows up in practice. Obsidian on a device quietly
rewrites a note (adding empty frontmatter to a generated daily note, for example). Sync carries
that edit back into the clone, the keeper sees a dirty tree, and it correctly refuses to
fast-forward. From then on the vault is frozen, and every generated note after that point never
reaches any device. The only signal is a status note, which nobody reads because nothing seems
wrong.

`discardLocalChanges` lets the operator say which paths git owns outright. Changed tracked files
matching those globs are restored from `HEAD` before the fast-forward. Sync then uploads the
restored version, so the device edit is reverted everywhere. Everything outside the globs keeps
the strict rules. `["**"]` makes the whole vault read-only from devices.

Only tracked files are restored. An untracked file (a note created on a phone, or a Sync conflict
copy) is reported but never deleted, because a deleted untracked file can't be recovered from
git.

### No upload-only mode

The ideal mode for a git-backed vault would be upload-only. The client offers `bidirectional`,
`pull-only` and `mirror-remote`, and the last two only download. So git-backed vaults run
bidirectionally, and device edits do reach the clone. The keeper makes them visible (status note,
metrics, alert), or reverts them (`discardLocalChanges`). They never reach git: the keeper doesn't
commit.

The first sync of a fresh clone against an existing remote vault merges whatever the remote
holds. If the remote was kept current from the same branch, nothing changes. If not, the first
status note shows the difference.

### The status note

`VAULT-STATUS.md` is written into each git-backed vault on every pass. It syncs to devices like
any other note, so drift is visible from a phone without cluster access. It's written atomically
through a dotfile temp name, which the client ignores. The keeper refuses to write it when the
repository tracks it, because a tracked status note would make the clone permanently dirty.

## What notices when it stops

A sync client that is running but stuck looks exactly like one that is idle. The chart gives each
failure mode its own signal:

| Failure | Detected by |
|---|---|
| Client process exits | Container exits with the client's code; Kubernetes restarts it |
| Client hangs silently | Liveness probe: no output for `sync.livenessStaleSeconds`. An idle client logs "Fully synced" every 30 seconds, so silence means stuck |
| Client runs but never converges | `ObsidianVaultSyncStale`: no "Fully synced" for `syncStaleSeconds` |
| Keeper loop wedges | `/healthz` fails after three intervals; liveness restarts it. `ObsidianKeeperStalled` |
| Vault can't follow git | `ObsidianVaultGitNotOK` after `gitNotOkFor`; status note on devices |
| Whole pod gone | `ObsidianHeadlessDown` (`up == 0` or absent) |

The sync supervisor writes a small status file per vault into a shared in-memory volume. Its
mtime is the liveness heartbeat, and its contents feed the keeper's metrics, so every metric
comes from one scrape target.

Keeper state (including how long a vault has been in its current state) lives in memory, so a
keeper restart restarts the `gitNotOkFor` clock. That's acceptable: a restart loop is itself
alerted on, and the status note still shows the state.

## The status page

The keeper serves a read-only HTML page on its own listener, separate from `/metrics`. Decided in
[`proposals/web-ui.md`](proposals/web-ui.md) (tier 1, OPS-1264); the reasoning in brief:

- **Not on the metrics port.** `:9090` is behind a `ClusterIP` Service, so anything in the
  cluster can read it. The page adds file names (note titles, often personal, and attacker-chosen
  when a device is compromised) and client log lines. So it gets its own port, bound to
  `127.0.0.1` and left out of the Service. `kubectl port-forward` connects inside the pod's network
  namespace, so it reaches a loopback listener; nothing else does.
- **Host allowlist on every request.** A page in the operator's browser can point a hostname it
  controls at `127.0.0.1` and read an open port-forward (DNS rebinding). The browser still sends
  the attacker's hostname as `Host`, so anything other than `localhost`, `127.0.0.1`, `[::1]` and
  `ui.allowedHosts` gets 421 before routing.
- **No script, strict CSP, everything escaped.** The page is server-rendered with one escaping
  helper for every interpolated value, refreshes with `<meta http-equiv="refresh">`, and is served
  with `default-src 'none'`. Tier 2 (setup wizard, OPS-1265) adds routes to this listener and
  inherits all of it.
- **Exposure is an explicit opt-in.** A non-loopback `ui.listenAddress` adds the port to the
  Service and requires `ui.allowedHosts`. The chart renders no Ingress; authentication in front of
  it is the operator's.

Keeper results come from the same object that renders `VAULT-STATUS.md`, including `fixHint()`,
so the page and the note can't disagree. The keeper is single-threaded and git calls are
synchronous, so the page doesn't answer during a pass; a refreshing status page tolerates that.

## Non-goals

- **Obsidian Publish.** The client supports it, but it is a separate workflow.
- **Writing back to git.** Device edits are never committed. Making git bidirectional would need
  conflict handling this chart shouldn't own.
- **Multiple replicas or HA.** See "One replica, always".
- **Managing the vault list from a browser.** Vaults are declared in values and rendered as one
  container each, so the repo describes what the pod syncs. A browser UI may log in and link the
  vaults values declare, but it doesn't add or remove them. Considered and declined in
  [`proposals/web-ui.md`](proposals/web-ui.md) (tier 3, OPS-1266).
