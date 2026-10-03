# Proposal: a web UI for setup and status

Status: **reviewed and decided** (OPS-1267, 2026-10-03). Tier 1 (OPS-1264) and tier 2 (OPS-1265)
are released to build, in that order. Tier 3 (OPS-1266) is cancelled as a non-goal and recorded in
[`docs/design.md`](../design.md#non-goals).

The original proposal is kept below as written where it held up. [Review](#review) records what
the review checked, what it corrected, and how each open question was answered. Where the two
disagree, the review and the revised tier specs win.

## Why

Setting up the chart today takes a terminal session (`ob login`), a Secret per credential, and a
values file that names each remote vault exactly. That works for someone already running GitOps
with 1Password. For most people who'd pick up a public chart, it's the reason they won't. And once
the chart is running, the only health view is Prometheus metrics, kubectl logs, or the
`VAULT-STATUS.md` note inside git-backed vaults.

A browser page could fix both: guided setup the first time, and a status view after that.

## What the client makes possible

These were checked against the pinned client (`obsidian-headless@0.0.14`, `cli.js`) during review.

- **Login can happen inside the pod.** `ob login` writes its token to
  `$XDG_CONFIG_HOME/obsidian-headless/auth_token` (mode 0600), which is on the data volume. A
  wizard doesn't need to create a Kubernetes Secret, so the pod needs no Kubernetes API access.
- **The E2E password is needed once.** `ob sync-setup` derives the vault key and stores it in the
  client's per-vault config on the volume. After linking, the password isn't needed again.
- **The client reads `OBSIDIAN_AUTH_TOKEN` before the token file.** Confirmed: the token lookup
  returns the env var if set and only then reads the file. If the chart sets the env var from a
  Secret, a token from browser login is ignored.
- **`ob login` revokes whatever token it finds first.** Found in review, and it matters more than
  the precedence rule. Given `--email` or `--password`, login takes the current token (env var
  first, then file), signs it out on Obsidian's servers, deletes the file, and only then logs in.
  A browser login in a pod that also carries the Secret would kill the Secret's token for every
  container, and the new token it writes would be ignored. See decision 2.
- **Secrets can reach the client on stdin, not argv.** Found in review. When stdin isn't a TTY,
  each prompt reads stdin to EOF. So `ob login --email <e> --mfa <code>` with the password piped
  on stdin works, and so does `ob sync-setup` *without* `--json` with the E2E password on stdin
  (with `--json` the client never prompts, which is why `prepare` passes it as an argument today).
  Only one secret per process can go this way, since the first prompt consumes all of stdin, and
  one per process is all either command needs.
- **`sync-list-remote --json` does not report encryption.** The proposal assumed it did. It
  returns `id`, `name` and `region` only. Whether a vault needs an E2E password is learned by
  attempting `sync-setup` without one: the client exits 2 with `Password not provided.` for an
  E2E vault, and exits 2 with `Failed to validate password.` for a wrong one.

## Review

### What was checked

The proposal against `image/app/` (`prepare`, `sync`, `keeper` and their libs), the chart
templates and values, `docs/design.md`, and the pinned client's source. Nothing here was run
against a live Obsidian account; the client behaviors above come from reading `cli.js`, and the
tier 2 acceptance criteria require confirming them on a real account.

### Corrections to the proposal

1. **Tier 1 should not share the metrics port.** The keeper's `:9090` is behind a `ClusterIP`
   Service that is on by default, and is what Prometheus scrapes. Anything in the cluster that can
   reach the Service can read it. Metrics expose vault names; the status page would add the names
   of changed and untracked files (which are note titles, often personal ones, and attacker-chosen
   if a device is compromised) and the last line each client logged. That is a step up in what
   leaks, so the UI gets its own listener bound to `127.0.0.1`, reached by `kubectl port-forward`,
   and not added to the Service. `/metrics` and `/healthz` stay exactly where they are.
2. **Encryption type is not available up front.** See above. The wizard learns it from the link
   attempt.
3. **The argv exposure can be removed rather than moved.** The proposal accepted that login and
   linking would put the password in the keeper's process list. Feeding it on stdin avoids that,
   and the same change fixes `prepare`'s existing exposure. Tier 2 does both.
4. **Browser login is destructive in a Secret-mode pod**, because of the revocation above. The
   proposal treated precedence as a preference question. It is a safety question.
5. **The keeper blocks while it runs a pass.** Every git call is `spawnSync`, so during a pass the
   HTTP server doesn't answer. That is fine for a status page that refreshes. Wizard actions must
   use async `spawn` with a timeout, run one at a time, and never call `run()`.
6. **The keeper's memory limit (256Mi) now has to hold an `ob` process.** `prepare` gets 1Gi for
   the same commands. Tier 2 measures peak RSS of `ob login` and `ob sync-setup` and raises
   `keeper.resources.limits.memory` to cover it.

### Decisions

**1. Ship tier 1 alone first.** Tier 1 builds the UI listener and its security baseline (loopback
bind, Host allowlist, escaping, CSP). Tier 2 adds routes to that listener and changes `prepare`,
`sync` and the chart's auth handling. Building them in parallel would have both PRs creating the
same server in `keeper.mjs`. OPS-1265 is marked `blocked_by` OPS-1264 in Plane, so the fleet's
dependency gate holds it until tier 1 is Done.

**2. The Secret wins, and the two auth sources are exclusive per install.** Not "both, with a
precedence":

- `obsidian.auth.existingSecret` set: **Secret mode.** Behavior is unchanged from today, including
  `prepare` failing the pod on a missing link or a bad password. The wizard's login and link
  routes are not served; the page says auth is managed by a Secret.
- `obsidian.auth.existingSecret` empty: **wizard mode.** No container gets `OBSIDIAN_AUTH_TOKEN`.
  The token lives in the file on the volume, written by the wizard.

The file can't win without the chart unsetting the env var, and a wizard that silently revokes a
GitOps-managed token is the worst outcome on the table. Keeping Secret mode byte-for-byte as it is
also keeps the design's fail-fast property ("All vaults share one init container") for everyone
already running the chart. Switching modes is a values change: from wizard to Secret mode, delete
`/data/config/obsidian-headless/auth_token` after the rollout. Don't `ob logout` it, for the same
reason the README gives.

**3. No setup code for the read-only page.** The code exists to stop someone who can reach the
port from acting on the account. The status page can't act on anything, and the loopback bind
already limits who can reach it to people with `pods/portforward`. The threat a code would have
covered is a malicious web page reading an open port-forward through DNS rebinding, and the Host
header allowlist covers that for every route without a code. Wizard routes keep the code.

**4. Tier 3 is a non-goal. OPS-1266 is cancelled.** Tier 2 removes the two steps that actually
stop people (a terminal login and hand-made Secrets). What remains is naming vaults in values,
which is the premise of a GitOps chart, and the wizard prints the exact snippet to paste. Tier 3
would trade per-vault restarts, probes and limits, and the repo describing the cluster, to save a
values edit and a `helm upgrade`. Recorded in `docs/design.md` under Non-goals. If real demand
shows up, file a new ticket that argues against that entry.

**5. Plain server-rendered HTML from the keeper.** No build step, no dependencies, no client-side
JavaScript. Forms post back to the server; the status page refreshes with
`<meta http-equiv="refresh">`. It matches the rest of the runtime (Node built-ins only), keeps
the CSP strict, and gives an attacker no script to inject into.

## Three tiers

### Tier 1: status page (OPS-1264)

The keeper starts a second HTTP listener for the UI and serves a status page at `/`. For each
vault it shows: when the sync client started, when it last reported "Fully synced", and the last
line it logged (from the sync status files the keeper already reads for metrics). For git-backed
vaults it adds the keeper state and how long it has been in it, branch, HEAD, how far the clone is
behind, the changed and untracked files, and the fix command. That is the same content as
`VAULT-STATUS.md`, so reuse `fixHint()` and the result object rather than re-deriving it.
Before the keeper's first pass finishes, git vaults show as pending.

Requirements:

- **New listener, not the metrics port.** `ui.enabled` (default `true`), `ui.port` (default
  `8080`), `ui.listenAddress` (default `127.0.0.1`). The chart adds a `ui` containerPort to the
  keeper and does **not** add it to the Service. Access is
  `kubectl port-forward deploy/<release> 8080:8080`, and `NOTES.txt` says so.
- **Host allowlist on every UI request.** Accept `localhost`, `127.0.0.1` and `[::1]` (any port),
  plus `ui.allowedHosts`. Anything else gets 421. This is the DNS rebinding defence.
- **Escape everything.** File names, log lines, commit subjects and vault names are all untrusted.
  One escaping helper, used for every interpolation, with a test that feeds it a file named
  `<img src=x onerror=alert(1)>.md`.
- **Headers:** `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  form-action 'self'; frame-ancestors 'none'`, plus `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`.
- **`ui.listenAddress` set to a non-loopback address** is the exposure opt-in. The chart then
  also adds a `ui` port to the Service, and requires `ui.allowedHosts` to be non-empty
  (`ohs.validate`). The chart renders no Ingress or HTTPRoute; whoever exposes it brings their own
  authentication in front.
- Tests: page renders for a pod with no git vaults, for each keeper state, and before the first
  pass; Host rejection; escaping; the metrics port still serves only `/metrics` and `/healthz`.
- Acceptance includes one real `kubectl port-forward` to the loopback-bound port on a cluster,
  pasted into the PR. Port-forward connects inside the pod's network namespace, so a loopback
  listener should be reachable, but this is the claim the whole security model rests on.

Size: about a day, including tests.

### Tier 2: setup wizard (OPS-1265)

Blocked by OPS-1264. Only active in wizard mode (decision 2).

The flow:

1. Enter the setup code from the keeper's log (below).
2. Log in with email, password and 2FA code. The keeper runs
   `ob login --email <email> [--mfa <code>]` with the password on stdin and
   `OBSIDIAN_AUTH_TOKEN` unset in the child env. If the account needs 2FA and no code was given,
   the client prompts again on an already-closed stdin and waits forever; the child's timeout
   (30s) turns that into "this account needs a 2FA code".
3. See the account's remote vaults (`ob sync-list-remote --json`, both `vaults` and `shared`).
4. For each vault declared in values that isn't linked yet: link it. Run `sync-setup` without a
   password first. On `Password not provided.`, ask for the E2E password and retry with it on
   stdin. On `Multiple vaults named`, show the IDs and the values change to make. After a
   successful link, apply `sync-config` exactly as `prepare` does.
5. For remote vaults not in values: show the exact values snippet to add.
6. Re-login stays available after setup, because a revoked or expired token is the main day-2
   use. Re-login revokes the old token, so the running sync containers fail and are restarted
   (by exit, or by the liveness probe if the client hangs instead) and pick up the new file.

The vault list stays in Helm values, deliberately. Containers are rendered per vault at install
time, and GitOps users need the repo to describe the cluster. The wizard links what values
declare; it doesn't add vaults.

Runtime changes:

- **Chart.** `obsidian.auth.existingSecret` becomes optional. `ohs.authEnv` renders nothing when
  it's empty. The rendered config carries `authMode: secret|file`. `ohs.validate` stops requiring
  the Secret.
- **Shared linking code.** Move `ensureLinked` and `applySyncConfig` out of `prepare.mjs` into a
  lib both `prepare` and the keeper call, so the wizard links a vault exactly the way `prepare`
  does, including the refusal to re-link a directory that points at a different remote.
- **E2E password on stdin, in `prepare` too.** Drop `--json` from `sync-setup` and pipe the
  password. Update "Linking vaults" in `docs/design.md`, which currently explains the argv
  exposure.
- **`prepare` in wizard mode.** Install the client and clone git vaults exactly as today, failing
  hard on errors. That keeps the guarantee that a git vault is cloned before Sync can touch it.
  Then link only if a token file exists, and skip vaults that aren't linked yet instead of failing.
  `sync-config` runs only for linked vaults. In Secret mode nothing changes.
- **`sync.mjs` waits for its link.** Before spawning `ob sync`, poll `ob sync-status --path` every
  10 seconds until it exits 0, writing the status file on every poll (that's the liveness
  heartbeat) with a `waiting: "not-linked"` field. Without this, `ob sync` exits 3 on an unlinked
  path and the container crash-loops.
- **Metrics.** Export `obsidian_headless_sync_linked{vault}` (0 or 1) from the status file.
  `ObsidianVaultSyncStale` keeps firing for a vault that stays unlinked, which is intended: a vault
  declared in values but not syncing for 30 minutes is the half-configured pod the design warns
  about, and the alert is what keeps it from looking healthy.
- **Wizard actions** use async `spawn` with a timeout, run one at a time, and never log their
  arguments or stdin.
- **Keeper memory limit** raised to cover a concurrent `ob` process, from a measured peak
  (correction 6).

Size: a few days.

### Tier 3: browser-managed vaults (OPS-1266)

**Cancelled as a non-goal (decision 4).** Kept here as the record of what was considered.

Add and remove vaults from the page. The vault list moves from values onto the volume, and a
single supervisor process manages one `ob sync` child per vault at runtime, replacing the
container-per-vault design.

Costs:

- It reverses a deliberate design decision (`docs/design.md`, "One container per vault"):
  separate restarts, logs, liveness probes and memory limits per vault.
- The cluster stops matching the repo: a GitOps user can't see from git which vaults the pod
  syncs.
- Removing a vault needs `ob sync-unlink` and a decision about the directory on the volume.

## Security model

Whoever can drive the wizard can log in as the account owner and read every vault. So:

- **Default: loopback only.** The UI listens on `127.0.0.1` and isn't in the Service. Reaching it
  takes `kubectl port-forward`, which takes cluster credentials. Nothing else in the cluster,
  including Prometheus, can reach it.
- **Host allowlist on every route**, against DNS rebinding through an open port-forward.
- **Wizard routes need a setup code.** 128 random bits, generated at each keeper start and printed
  once to the keeper's log. Entering it sets an `HttpOnly`, `SameSite=Strict` session cookie, and
  every wizard POST requires that cookie plus a matching `Origin`. That covers a port-forward left
  open and a malicious page posting to it. The code may end up in a log aggregator; on its own it
  is useless without network reach to the loopback port. Precedent: Jupyter's token.
- **Wizard routes don't exist in Secret mode**, so the revocation hazard can't be triggered.
- **Exposure is an explicit opt-in** (`ui.listenAddress`), requires `ui.allowedHosts`, and still
  requires the setup code for wizard routes. The chart doesn't render an Ingress; authentication in
  front of it is the operator's.
- **Secrets never touch argv or logs.** Passwords go to `ob` on stdin. The 2FA code goes as an
  argument; it is single-use and expires in seconds.
- **The token file is on the PVC.** In wizard mode, a backup of the volume carries the token, the
  same way a backup of the Secret would in Secret mode.
