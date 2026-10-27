#!/bin/sh
# Runs inside the Railway cron container. Clones (or updates) both repos on the persistent volume,
# runs the daily collection from the repo's own code, then commits and pushes the results.
# Unpushed commits survive on the volume and are pushed on the next run.
set -eu
DATA="${RAILWAY_VOLUME_MOUNT_PATH:-/data}"
PUB="$DATA/decision-drift"
PRIV="$PUB/private"
DATE="$(date -u +%Y-%m-%d)"
: "${GITHUB_TOKEN:?missing}" "${OPENROUTER_API_KEY:?missing}"
# The token never appears in a remote URL or .git/config; git asks for it through GIT_ASKPASS.
printf '#!/bin/sh\necho "$GITHUB_TOKEN"\n' > /tmp/askpass && chmod 700 /tmp/askpass
export GIT_ASKPASS=/tmp/askpass GIT_TERMINAL_PROMPT=0
REMOTE_PUB="https://x-access-token@github.com/bomliu/decision-drift.git"
REMOTE_PRIV="https://x-access-token@github.com/bomliu/decision-drift-private.git"
export GIT_AUTHOR_NAME=bomliu GIT_COMMITTER_NAME=bomliu
export GIT_AUTHOR_EMAIL=1945172+bomliu@users.noreply.github.com GIT_COMMITTER_EMAIL=1945172+bomliu@users.noreply.github.com

sync() { # $1 dir, $2 remote
  if [ -d "$1/.git" ]; then git -C "$1" remote set-url origin "$2"; git -C "$1" pull --rebase --quiet origin main
  else git clone --quiet "$2" "$1"; fi
}
push() { # $1 dir; retry with rebase so a concurrent push never loses data
  for i in 1 2 3; do git -C "$1" push --quiet origin main && return 0; sleep $((i * 20)); git -C "$1" pull --rebase --quiet origin main || true; done
  echo "push failed for $1; commits stay on the volume for the next run"; return 1
}

sync "$PUB" "$REMOTE_PUB"
sync "$PRIV" "$REMOTE_PRIV"
cd "$PUB"
STATUS=ok
scripts/daily.sh daily || STATUS=failed
node src/compact.ts "results/$DATE" "private/results/$DATE" || true
node src/status.ts --date "$DATE" --run daily --status "$STATUS" || true

git -C "$PRIV" add -A results && git -C "$PRIV" commit --quiet -m "data: private results $DATE" || true
git add results reports status.json && git commit --quiet -m "data: daily run $DATE ($STATUS)" || true
RC=0
push "$PRIV" || RC=1
push "$PUB" || RC=1
[ "$STATUS" = ok ] || RC=1
exit $RC
