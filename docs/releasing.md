# Releasing

The chart and the image share one version. `Chart.yaml` `version`, `Chart.yaml` `appVersion` and
`image/app/package.json` `version` always match, and the chart's default image tag is its
`appVersion`.

1. In a pull request, bump all three to the new version. Bump the client pin in
   `image/ob/package.json` as well, if that is part of the release: run
   `npm install --package-lock-only` in `image/ob` and commit the lockfile.
2. Merge. CI publishes `ghcr.io/nprodromou/obsidian-headless-sync:sha-<commit>` and `:main`.
3. Tag the merge commit `vX.Y.Z` and push the tag. `release.yml` refuses a tag that disagrees
   with the three versions. It then pushes the image as `:X.Y.Z`, the chart to
   `oci://ghcr.io/nprodromou/charts/obsidian-headless-sync`, and creates a GitHub release.

The first time each package is published, GHCR makes it private. Set both
`obsidian-headless-sync` packages (container and chart) to public once, under the package's
settings on GitHub.

## Bumping the Obsidian client

The client version is pinned by `image/ob/package-lock.json`, so a bump is an image release. Pods
reinstall the client on their next start, because the install marker on the data volume includes
the lockfile's hash. Read the client's changelog before bumping. It is pre-1.0, and the chart
depends on its CLI flags, on the exit codes of `sync-status` (3 for not linked, 2 for a missing
encryption key), and on it logging "Fully synced".
