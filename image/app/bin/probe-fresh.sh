#!/bin/sh
# Liveness probe for a sync container: passes while the vault's status file
# was modified within the last MAX_AGE seconds.
#   probe-fresh.sh <file> <max-age-seconds>
f="$1"
max="$2"
[ -f "$f" ] || exit 1
now=$(date +%s)
mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f") || exit 1
[ $((now - mtime)) -le "$max" ]
