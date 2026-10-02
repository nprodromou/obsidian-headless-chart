# Proposal: a web UI for setup and status

Status: proposed, awaiting design review (OPS-1267). Tracking: OPS-1264 (tier 1), OPS-1265 (tier 2), OPS-1266
(tier 3).

## Why

Setting up the chart today takes a terminal session (`ob login`), a Secret per credential, and a
values file that names each remote vault exactly. That works for someone already running GitOps
with 1Password. For most people who'd pick up a public chart, it's the reason they won't. And once
the chart is running, the only health view is Prometheus metrics, kubectl logs, or the
`VAULT-STATUS.md` note inside git-backed vaults.

A browser page could fix both: guided setup the first time, and a status view after that.

## What the client makes possible

Two properties of `ob` make an in-pod UI simpler than it first looks:

- **Login can happen inside the pod.** `ob login --email --password --mfa` writes its token to
  `$XDG_CONFIG_HOME/obsidian-headless/auth_token`, which is on the data volume. A wizard doesn't
  need to create a Kubernetes Secret, so the pod needs no Kubernetes API access.
- **The E2E password is needed once.** `ob sync-setup` derives the vault key and stores it in the
  client's per-vault config on the volume. After linking, the password isn't needed again.

One property works against it:

- **The client reads `OBSIDIAN_AUTH_TOKEN` before the token file.** If the chart sets the env var
  from a Secret, a token from browser login is ignored. So `obsidian.auth.existingSecret` has to
  become optional, and the two sources need a stated precedence.

## Three tiers

### Tier 1: status page (OPS-1264)

The keeper serves an HTML page on the port it already listens on (`/`, beside `/metrics` and
`/healthz`). For each vault it shows: the sync client's state, when it last reported "Fully
synced", and the last line it logged. For git-backed vaults it adds the keeper state, how far the
clone is behind, what's blocking it, and the fix command, which is the same content as
`VAULT-STATUS.md`.

- Read-only. No new container, no new secrets, no new attack surface beyond showing vault
  names, file paths and log lines.
- All the data already exists in the keeper's state and the per-vault sync status files.
- Size: about a day, including tests.

### Tier 2: setup wizard (OPS-1265)

A first-run flow:

1. Log in with email, password and 2FA.
2. See the account's remote vaults (`ob sync-list-remote --json`), including each one's
   encryption type.
3. For each vault declared in values that isn't linked yet: enter the E2E password if it needs
   one, then link it.
4. For remote vaults not in values: show the exact values snippet to add.

The vault list stays in Helm values, deliberately. Containers are rendered per vault at install
time, and GitOps users need the repo to describe the cluster. The wizard links what values
declare; it doesn't add vaults.

What has to change in the runtime:

- `prepare` currently fails the pod when there's no token or a vault can't be linked. With a
  wizard, an unlinked vault is a normal first-run state. So `prepare` would skip unlinked vaults,
  and each sync container would wait (with a status the page can show) until its vault is linked.
- Login and linking pass the password and E2E password to `ob` as arguments. They'd be visible in
  the keeper container's process list while the command runs. The init container already has the
  same exposure today; the wizard moves it into a long-running container.

Size: a few days.

### Tier 3: browser-managed vaults (OPS-1266)

Add and remove vaults from the page. The vault list moves from values onto the volume, and a
single supervisor process manages one `ob sync` child per vault at runtime, replacing the
container-per-vault design.

Costs:

- It reverses a deliberate design decision (`docs/design.md`, "One container per vault"):
  separate restarts, logs, liveness probes and memory limits per vault.
- The cluster stops matching the repo: a GitOps user can't see from git which vaults the pod
  syncs.
- Removing a vault needs `ob sync-unlink` and a decision about the directory on the volume.

Size: one to two weeks. Recommendation: don't build it until someone actually needs it.

## Security model (tiers 2 and 3)

This page would accept an Obsidian password and 2FA code, and whoever can reach it can read
every vault. So:

- **Default: not exposed.** The Service stays `ClusterIP`. Access is by
  `kubectl port-forward`, which already requires cluster credentials.
- **Exposing it is an explicit opt-in**, and the chart won't render an Ingress or HTTPRoute for it
  without the user stating how it is authenticated (an auth proxy, or an authenticated route).
- **Wizard actions need a one-time setup code**, printed to the keeper's log at start. That way a
  port-forward someone left open isn't enough to take over the account. Precedent: Jupyter's
  token.
- **Tier 1 alone could reasonably be exposed more widely**, since it's read-only, but it still
  shows vault names and file paths. It stays behind the same default.

## Open questions for the review

1. Ship tier 1 alone first, or tiers 1 and 2 together?
2. Token precedence when both a Secret and a browser login exist: Secret wins (GitOps users stay
   in control), or the file wins (the wizard always works)?
3. Should the setup code apply to tier 1's read-only page too?
4. Is tier 3 worth keeping as a ticket at all, or closed as a non-goal next to `docs/design.md`'s
   other non-goals?
5. UI technology: plain server-rendered HTML from the keeper (no build step, no dependencies,
   consistent with the rest of the runtime), or something heavier?
