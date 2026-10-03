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
│                      and, in wizard mode, the setup wizard
├── sync-<vault-a>     wait for the link, then ob sync --continuous (supervised)
└── sync-<vault-b>     ...

/data                       PVC
├── .ob/                    installed client, keyed by lockfile hash + Node ABI + arch
├── config/                 XDG_CONFIG_HOME: per-vault sync state, and the auth token in wizard mode
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
why in `kubectl logs -c prepare`. Wizard mode relaxes this for linking only, because a vault can't
be linked before someone has logged in; see [Linking vaults](#linking-vaults) for what keeps an
unlinked vault from looking healthy.

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

The chart has two auth modes, and they are exclusive per install:

- **Secret mode** (`obsidian.auth.existingSecret` set). `prepare` and the sync containers get
  `OBSIDIAN_AUTH_TOKEN` from the Secret, and every vault must link or the pod doesn't start.
- **Wizard mode** (no Secret). No container gets `OBSIDIAN_AUTH_TOKEN`. The token is the file
  `ob login` writes under `XDG_CONFIG_HOME` on the data volume, and the [setup
  wizard](#the-setup-wizard) is how it gets there.

They can't be combined with a precedence. The client reads the env var before the file, so a file
written by the wizard would be ignored while the Secret is set. Worse, `ob login` signs out
whatever token it finds before logging in, so a browser login in a Secret-mode pod would revoke
the Secret's token for every container. Decision 2 in [`proposals/web-ui.md`](proposals/web-ui.md)
has the full argument. To move from wizard to Secret mode, set the Secret and then delete
`/data/config/obsidian-headless/auth_token` after the rollout. Don't `ob logout` it: that revokes
the token on Obsidian's servers, and nothing else needs it to be.

`prepare` and the wizard link a vault with the same code (`lib/link.mjs`), so they make the same
decisions. Each starts with `ob sync-status --path <dir> --json`:

- **Exit 0:** already linked. If it's linked to a different remote than configured, it refuses to
  re-link. Changing which remote a directory syncs with is a decision, and getting it wrong merges
  two vaults. `prepare` fails the pod on it in both modes.
- **Exit 3** (no configuration) **or 2** (encryption key missing): runs `ob sync-setup`.
- **Anything else** fails the pod in Secret mode, and is reported in wizard mode.

`ob sync-config` runs on every start for every linked vault, and right after the wizard links one,
so edited sync values take effect on the next rollout.

**The end-to-end encryption password goes to the client on stdin.** It is only needed by
`sync-setup`, which derives the key and stores it in the client's config on the data volume.
`sync-setup` runs without `--json`, so it prompts for the password when the vault needs one, and a
prompt on a stdin that isn't a terminal reads it to EOF. So the password never appears in argv,
where every process in the pod could read it. Running with an empty stdin is also how the wizard
learns whether a vault needs a password at all: `sync-list-remote` doesn't say, and the client
exits 2 with `Password not provided.` for an E2E vault (`Failed to validate password.` for a wrong
one). `ob login` gets the account password the same way. Only one secret per process can go this
way, since the first prompt consumes all of stdin, and one is all either command needs.

**In wizard mode `prepare` links what it can.** It installs the client and clones git vaults
exactly as in Secret mode, failing hard on errors, which keeps the guarantee that a git vault is
cloned before Sync can touch it. Then, only if the token file exists, it links each vault (with
its `encryption` Secret, if values give one) and skips any vault it can't link instead of failing.

**Each sync container waits for its link.** Before starting `ob sync`, the supervisor polls
`ob sync-status` every 10 seconds until it exits 0. Without that, `ob sync` exits 3 on an unlinked
path and the container crash-loops. Each poll rewrites the vault's status file with
`waiting: "not-linked"`, which keeps the liveness probe satisfied and drives
`obsidian_headless_sync_linked{vault}` to 0. `ObsidianVaultSyncStale` keeps firing for a vault
that stays unlinked, measured from when its container started. That's intended: a vault declared
in values but not syncing for half an hour is the half-configured pod the previous section warns
about, and the alert is what stops it looking healthy. In Secret mode the first poll passes.

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
| Vault never linked (wizard mode) | `obsidian_headless_sync_linked` is 0; `ObsidianVaultSyncStale` after `syncStaleSeconds` |
| Whole pod gone | `ObsidianHeadlessDown` (`up == 0` or absent) |

The sync supervisor writes a small status file per vault into a shared in-memory volume. Its
mtime is the liveness heartbeat, and its contents feed the keeper's metrics, so every metric
comes from one scrape target.

Keeper state (including how long a vault has been in its current state) lives in memory, so a
keeper restart restarts the `gitNotOkFor` clock. That's acceptable: a restart loop is itself
alerted on, and the status note still shows the state.

## The status page

The keeper serves an HTML status page on its own listener, separate from `/metrics`. Decided in
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

## The setup wizard

In wizard mode the status page's listener also serves `/setup`: log in to Obsidian, see the
account's remote vaults, link each vault values declare, and get the values entries for remote
vaults nobody declared. Decided in [`proposals/web-ui.md`](proposals/web-ui.md) (tier 2,
OPS-1265). It inherits everything above (loopback bind, Host allowlist, escaping, CSP, no script)
and adds:

- **Not served in Secret mode.** The routes don't exist there, so the revocation hazard above
  can't be triggered from a browser.
- **A setup code.** Whoever drives the wizard can act as the account owner, so every `/setup`
  route needs a session, and a session takes the 128-bit code the keeper prints once to its log on
  each start. The code is useless without network reach to the listener, which is loopback unless
  `ui.listenAddress` opts in. Same idea as Jupyter's token.
- **Cookie plus Origin on every POST.** The session cookie is `HttpOnly` and `SameSite=Strict`,
  and a POST also needs an `Origin` header naming the host it was sent to. That covers a
  port-forward left open and a page elsewhere posting to it.
- **Secrets on stdin, nothing logged.** Account and E2E passwords go to `ob` on stdin. The 2FA
  code goes as an argument; it is single-use and expires in seconds. Arguments and input are never
  logged, only the outcome (`setup: login failed`). The child never sees `OBSIDIAN_AUTH_TOKEN`.
- **One action at a time, never blocking.** Actions are async children with a timeout (30 seconds
  for login), so the status page and `/metrics` keep answering. A second action while one runs
  gets 409.
- **2FA is detected, not asked about.** Given no code, an account with 2FA makes `ob login`
  re-prompt on a closed stdin. The pinned client then exits 0 having printed nothing; a client
  that waited instead would hit the timeout. Either way the wizard reports that a code is needed.
- **Re-login is the day-2 path.** A revoked or expired token is the main reason to come back.
  Re-login signs the old token out first, so running sync containers fail and are restarted (by
  exit, or by the liveness probe if the client hangs instead) and pick up the new file. If the new login
  fails, the pod is left logged out until one succeeds; the page says so.
- **The vault list stays in values.** The wizard links what values declare and prints the exact
  entries to add for the rest; it doesn't add vaults. See Non-goals.

The keeper's memory limit covers one `ob` process on top of a git pass. Measured against the
pinned client (offline, with its HTTP calls stubbed): about 66 MiB peak for `ob login` and about
100 MiB for `ob sync-setup` on an E2E vault, where scrypt key derivation dominates. The limit went
from 256Mi to 384Mi.

## Non-goals

- **Obsidian Publish.** The client supports it, but it is a separate workflow.
- **Writing back to git.** Device edits are never committed. Making git bidirectional would need
  conflict handling this chart shouldn't own.
- **Multiple replicas or HA.** See "One replica, always".
- **Managing the vault list from a browser.** Vaults are declared in values and rendered as one
  container each, so the repo describes what the pod syncs. A browser UI may log in and link the
  vaults values declare, but it doesn't add or remove them. Considered and declined in
  [`proposals/web-ui.md`](proposals/web-ui.md) (tier 3, OPS-1266).
