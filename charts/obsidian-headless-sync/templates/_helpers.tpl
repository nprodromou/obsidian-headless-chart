{{- define "ohs.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "ohs.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "ohs.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ohs.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "ohs.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "ohs.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "ohs.image" -}}
{{- if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}
{{- end }}

{{- define "ohs.deviceName" -}}
{{- .Values.obsidian.deviceName | default (include "ohs.fullname" .) }}
{{- end }}

{{- define "ohs.claimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" (include "ohs.fullname" .)) }}
{{- end }}

{{- define "ohs.hasGitVaults" -}}
{{- range .Values.vaults }}{{ if dig "git" "repository" "" . }}true{{ end }}{{ end }}
{{- end }}

{{/* "true" when the status page listens on something other than loopback. */}}
{{- define "ohs.uiExposed" -}}
{{- $a := .Values.ui.listenAddress | trimPrefix "[" | trimSuffix "]" | lower }}
{{- if and .Values.ui.enabled (not (or (hasPrefix "127." $a) (eq $a "::1") (eq $a "localhost"))) }}true{{ end }}
{{- end }}

{{/* Fail early on values the schema cannot express. */}}
{{- define "ohs.validate" -}}
{{- if not .Values.obsidian.auth.existingSecret }}
{{- fail "obsidian.auth.existingSecret is required: a Secret holding the token from `ob login`" }}
{{- end }}
{{- if not .Values.vaults }}
{{- fail "vaults is empty: configure at least one vault" }}
{{- end }}
{{- $seen := dict }}
{{- range .Values.vaults }}
{{- if hasKey $seen .name }}
{{- fail (printf "vault name %q is used twice" .name) }}
{{- end }}
{{- $_ := set $seen .name true }}
{{- end }}
{{- if and .Values.ui.enabled (eq (int .Values.ui.port) (int .Values.keeper.port)) }}
{{- fail "ui.port must differ from keeper.port" }}
{{- end }}
{{- if and (include "ohs.uiExposed" .) (not .Values.ui.allowedHosts) }}
{{- fail "ui.allowedHosts is required when ui.listenAddress is not loopback: list the host names the status page is reached by" }}
{{- end }}
{{- if and (include "ohs.hasGitVaults" .) (ne .Values.git.auth.type "none") (not .Values.git.auth.existingSecret) }}
{{- fail "git.auth.existingSecret is required when git.auth.type is token or ssh" }}
{{- end }}
{{- end }}

{{/* Environment shared by every container. */}}
{{- define "ohs.commonEnv" -}}
- name: HOME
  value: /tmp/home
- name: XDG_CONFIG_HOME
  value: /data/config
- name: OBSIDIAN_HEADLESS_CONFIG
  value: /etc/obsidian-headless/config.json
- name: NPM_CONFIG_CACHE
  value: /tmp/npm-cache
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "ohs.authEnv" -}}
- name: OBSIDIAN_AUTH_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.obsidian.auth.existingSecret }}
      key: {{ .Values.obsidian.auth.key }}
{{- end }}

{{/* Git environment for the init and keeper containers. */}}
{{- define "ohs.gitEnv" -}}
# The data volume is fsGroup-owned; git's ownership check would otherwise
# refuse clones written by the init container.
- name: GIT_CONFIG_COUNT
  value: "1"
- name: GIT_CONFIG_KEY_0
  value: safe.directory
- name: GIT_CONFIG_VALUE_0
  value: "*"
{{- $a := .Values.git.auth }}
{{- if eq $a.type "token" }}
- name: GIT_USERNAME
  value: {{ $a.username | quote }}
- name: GIT_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $a.existingSecret }}
      key: {{ $a.tokenKey }}
{{- else if eq $a.type "ssh" }}
- name: GIT_SSH_KEY_FILE
  value: /etc/obsidian-headless-git/{{ $a.sshKeyKey }}
{{- if $a.knownHostsKey }}
- name: GIT_SSH_KNOWN_HOSTS_FILE
  value: /etc/obsidian-headless-git/{{ $a.knownHostsKey }}
{{- end }}
{{- end }}
{{- end }}

{{- define "ohs.volumeMounts" -}}
- name: data
  mountPath: /data
- name: config
  mountPath: /etc/obsidian-headless
  readOnly: true
- name: tmp
  mountPath: /tmp
- name: run
  mountPath: /run/obsidian-headless
{{- end }}

{{- define "ohs.gitVolumeMount" -}}
{{- if eq .Values.git.auth.type "ssh" }}
- name: git-auth
  mountPath: /etc/obsidian-headless-git
  readOnly: true
{{- end }}
{{- end }}
