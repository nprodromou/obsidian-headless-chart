#!/usr/bin/env bash
# Chart checks, run locally and in CI:
#   1. helm lint --strict with every ci/*.yaml values file
#   2. rendered manifests validate against Kubernetes (and CRD) schemas
#   3. the rendered config.json loads through the app's own config parser
#   4. values the chart must refuse are refused at template time
#   5. the status page stays off the Service unless ui.listenAddress opts in
# Needs helm, kubeconform, yq (mikefarah) and node.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/charts/obsidian-headless-sync"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

K8S_VERSION="${K8S_VERSION:-1.30.0}"
CRD_SCHEMAS='https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'

for values in "$CHART"/ci/*.yaml; do
  name="$(basename "$values" .yaml)"
  echo "== $name"
  helm lint --strict "$CHART" -f "$values" --quiet
  helm template t "$CHART" -n obs -f "$values" > "$OUT/$name.yaml"
  helm template t "$CHART" -n obs -f "$values" --show-only templates/configmap.yaml \
    | yq '.data."config.json"' > "$OUT/$name.config.json"
  node --input-type=module -e "
    const { loadConfig } = await import('$ROOT/image/app/lib/config.mjs');
    const cfg = loadConfig('$OUT/$name.config.json');
    console.log('   config ok:', cfg.vaults.map((v) => v.name + (v.git ? ' (git)' : '')).join(', '));
  "
done

kubeconform -strict -summary -kubernetes-version "$K8S_VERSION" \
  -schema-location default -schema-location "$CRD_SCHEMAS" "$OUT"/*.yaml

# Each case must fail to render, with the expected message.
expect_fail() {
  local want="$1"; shift
  local err
  if err="$(helm template t "$CHART" "$@" 2>&1)"; then
    echo "FAIL: rendered but should have failed ($want)"; exit 1
  fi
  if ! grep -q -- "$want" <<<"$err"; then
    echo "FAIL: expected '$want', got:"; echo "$err"; exit 1
  fi
  echo "   refused as expected: $want"
}
echo "== invalid values"
expect_fail "obsidian.auth.existingSecret is required" --set 'vaults[0].name=a' --set 'vaults[0].remote=A'
expect_fail "vaults is empty" --set obsidian.auth.existingSecret=s
expect_fail "used twice" --set obsidian.auth.existingSecret=s \
  --set 'vaults[0].name=a' --set 'vaults[0].remote=A' --set 'vaults[1].name=a' --set 'vaults[1].remote=B'
expect_fail "vaults.0.name" --set obsidian.auth.existingSecret=s --set 'vaults[0].name=Bad_Name' --set 'vaults[0].remote=A'
expect_fail "git.auth.existingSecret is required" --set obsidian.auth.existingSecret=s \
  --set 'vaults[0].name=a' --set 'vaults[0].remote=A' --set 'vaults[0].git.repository=https://x/y.git' --set git.auth.type=token
expect_fail "vaults.0.sync.mode" --set obsidian.auth.existingSecret=s \
  --set 'vaults[0].name=a' --set 'vaults[0].remote=A' --set 'vaults[0].sync.mode=push-only'
expect_fail "ui.allowedHosts is required" --set obsidian.auth.existingSecret=s \
  --set 'vaults[0].name=a' --set 'vaults[0].remote=A' --set ui.listenAddress=0.0.0.0
expect_fail "ui.port must differ" --set obsidian.auth.existingSecret=s \
  --set 'vaults[0].name=a' --set 'vaults[0].remote=A' --set ui.port=9090

echo "== status page exposure"
svc_ports() { yq -r 'select(.kind == "Service") | .spec.ports[].name' "$OUT/$1.yaml" | sort | tr '\n' ' '; }
keeper_ports() { yq -r 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "keeper") | .ports[].name' "$OUT/$1.yaml" | sort | tr '\n' ' '; }
[[ "$(svc_ports minimal-values)" == "metrics " ]] || { echo "FAIL: default Service ports: $(svc_ports minimal-values)"; exit 1; }
[[ "$(keeper_ports minimal-values)" == "metrics ui " ]] || { echo "FAIL: default keeper ports: $(keeper_ports minimal-values)"; exit 1; }
[[ "$(svc_ports ui-exposed-values)" == "metrics ui " ]] || { echo "FAIL: exposed Service ports: $(svc_ports ui-exposed-values)"; exit 1; }
grep -q '"listenAddress": "127.0.0.1"' "$OUT/minimal-values.config.json" || { echo "FAIL: default ui.listenAddress is not loopback"; exit 1; }
off="$(helm template t "$CHART" -f "$CHART/ci/minimal-values.yaml" --set ui.enabled=false)"
if yq -e 'select(.kind == "Deployment") | .spec.template.spec.containers[] | select(.name == "keeper") | .ports[] | select(.name == "ui")' <<<"$off" >/dev/null 2>&1; then
  echo "FAIL: ui.enabled=false still renders the ui port"; exit 1
fi
echo "   ui port: keeper only by default, on the Service only when exposed"

echo "chart checks passed"
