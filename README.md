# obsidian-headless-sync

A Helm chart that runs [Obsidian Sync](https://obsidian.md/sync) on Kubernetes with the official
[headless client](https://obsidian.md/help/sync/headless), so your vaults sync without a desktop
machine that has to stay awake.

It can also treat a git repository as the source of truth for a vault: the pod keeps a clone
fast-forwarded to the remote's default branch, and Sync carries each update to your phone and
tablet. Notes you write in git show up on every device.

This project is not affiliated with or endorsed by Obsidian. You need your own Obsidian Sync
subscription.

## How it works

One pod holds every vault:

- **`prepare`** (init container) installs the official client, clones any git-backed vaults, and
  links each directory to its remote vault.
- **`sync-<vault>`** runs `ob sync --continuous` for one vault. One container per vault, so a
  problem with one vault restarts only that vault.
- **`keeper`** fast-forwards git-backed vaults on an interval, writes a status note into each,
  and serves `/metrics` and `/healthz`.

The published image does **not** contain the Obsidian client, because that package is not openly
licensed. The init container installs the version pinned in [`image/ob/package-lock.json`](image/ob/package-lock.json)
from npm on first start, verifying each package's integrity hash, and reuses it after that. The
pod therefore needs outbound access to `registry.npmjs.org` and `github.com` on first start, as
well as to Obsidian Sync. [`docs/design.md`](docs/design.md) covers the reasoning.

## Quick start

**1. Get an auth token.** Log in once on any machine with Node 22 or newer:

```bash
npx obsidian-headless@0.0.14 login
```

The token is saved to `~/.obsidian-headless/auth_token` on macOS, or
`~/.config/obsidian-headless/auth_token` on Linux. Put it in a Secret, then delete the local file.
Don't run `ob logout` to clean up: it signs the token out on Obsidian's servers, which breaks the
pod.

```bash
kubectl create secret generic obsidian-auth \
  --from-file=OBSIDIAN_AUTH_TOKEN="$HOME/.obsidian-headless/auth_token"
```

For end-to-end encrypted vaults, also store each vault's encryption password:

```bash
kubectl create secret generic obsidian-e2e --from-literal=notes='your vault password'
```

**2. Write values.**

```yaml
obsidian:
  auth:
    existingSecret: obsidian-auth
vaults:
  - name: notes
    remote: My Notes            # name or ID, from `ob sync-list-remote`
    encryption:
      existingSecret: obsidian-e2e
      key: notes
```

**3. Install.**

```bash
helm install obsidian oci://ghcr.io/nprodromou/charts/obsidian-headless-sync \
  --version 0.1.0 -f values.yaml
```

Watch the first start with `kubectl logs deploy/obsidian-obsidian-headless-sync -c prepare -f`.

## Git-backed vaults

Add a `git` block and the vault follows that repository:

```yaml
vaults:
  - name: handbook
    remote: Handbook
    git:
      repository: https://github.com/you/handbook.git
      discardLocalChanges:
        - generated/**
git:
  auth:
    type: token                  # or ssh, or none for public repos
    existingSecret: github-readonly
```

Every `git.intervalSeconds` the keeper fetches and fast-forwards. It never commits, switches
branches, resets, stashes, or cleans. When a clone can't be fast-forwarded (a device edit, local
commits, a parked branch), the keeper leaves it alone and reports the reason. The vault then
stays behind until someone fixes it.

- **`VAULT-STATUS.md`** is written into each git-backed vault and syncs to your devices. It shows
  the state, what blocked it, and the exact command that fixes it. Add it to the repo's
  `.gitignore`.
- **`discardLocalChanges`** lists globs for files that git owns outright. A device edit to a
  matching file is restored from git before the fast-forward, so it can't freeze the vault.
  `["**"]` makes the vault read-only from every device.
- **Metrics and alerts** (below) catch a vault that stays blocked, so nobody has to read the note
  to find out.

The client has no upload-only mode, so git-backed vaults sync in both directions. An edit made on
a phone reaches the clone, where the keeper reports it (or restores it, per
`discardLocalChanges`). It never reaches git.

**Before pointing an existing remote vault at a fresh clone:** the first sync merges whatever the
remote holds into the clone. If the remote already matches the repo's default branch, that merge
does nothing. If it doesn't, expect `DIRTY` or untracked files on the first status note. Either
review them, or start from a new, empty remote vault.

## Monitoring

With `metrics.serviceMonitor.enabled` and `metrics.prometheusRule.enabled`, you get:

| Alert | Fires when |
|---|---|
| `ObsidianHeadlessDown` | `/metrics` has not been scraped for 15 minutes |
| `ObsidianVaultSyncStale` | a vault's client has not finished a sync pass for `syncStaleSeconds` |
| `ObsidianVaultGitNotOK` | a git-backed vault has been in a non-OK state for `gitNotOkFor` |
| `ObsidianKeeperStalled` | no keeper pass has finished in three intervals |

The pod restarts a sync container whose client goes silent for `sync.livenessStaleSeconds`. An
idle client logs every 30 seconds. It also restarts the keeper when its loop stops completing.

## Values

See [`values.yaml`](charts/obsidian-headless-sync/values.yaml) for every option and its comment.
[`values.schema.json`](charts/obsidian-headless-sync/values.schema.json) rejects malformed vault
entries at install time.

## Rotating or revoking the token

Replace the Secret and restart the pod. To revoke a token (for example, one that leaked), sign it
out from any machine:

```bash
OBSIDIAN_AUTH_TOKEN='<token>' npx obsidian-headless@0.0.14 logout
```

## Development

```bash
(cd image/app && npm test)   # keeper, config, status and metrics tests against real git repos
./scripts/test-chart.sh      # lint, render, schema-validate and contract-test the chart
```

CI builds the image for amd64 and arm64 on every pull request and smoke-runs it the way the chart
does. Releases: [`docs/releasing.md`](docs/releasing.md).

## License

Apache-2.0 for everything in this repository. The Obsidian headless client is Obsidian's, under
its own terms. This project installs it on your behalf and never redistributes it.
