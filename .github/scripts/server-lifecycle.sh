#!/usr/bin/env bash
#
# The four verbs a person actually uses: `start`, `status`, `restart`, `stop`.
#
# The smoke gate runs `serve` — the server in the foreground, which is not how anybody runs it. The
# detached path is a different mechanism (`spawn` with `detached: true`, a run-state record on disk,
# a successor that has to bind a port its predecessor is still releasing), and every one of its
# defects has been found by hand on a VM: `restart` used to leave no replacement running at all,
# because the old server had not let go of the port when the new one bound it.
#
#   .github/scripts/server-lifecycle.sh <binary> [port]
#
# What it asserts, in the order a person does it:
#
#   1. `start` exits 0, ONE run-state record appears, and `/api/config` answers 200.
#   2. `status` exits 0. Only that: it always exits 0 by design ("a server that is down is an
#      answer"), and its wording is a user-facing surface this script must not freeze.
#   3. `restart` exits 0, the recorded pid CHANGES, and the server answers again. That last pair is
#      the port race: a `restart` that killed the old server and failed to bind would leave the pid
#      unchanged, or nothing answering, and both are caught here.
#   4. `stop` exits 0, the record is gone, and nothing answers any more.
#
# Liveness is read from the run-state records (`$SEEDEEP_HOME/servers/<pid>.json`) rather than from
# what the commands print, for the same reason `status` is only checked for its exit code: the
# printed report is a surface, the record is a fact.
#
# `SEEDEEP_HOME` and `CLAUDE_CONFIG_DIR` are pointed at a temporary directory, so a run never stops,
# starts or adopts a seedeep the machine is already running.

set -uo pipefail

BIN=${1:?usage: server-lifecycle.sh <binary> [port]}
# Neither the default 44842, nor the smoke script's 44899, nor the survival script's 44898.
PORT=${2:-44897}
TIMEOUT_S=${LIFECYCLE_TIMEOUT_S:-60}

BASE="http://127.0.0.1:$PORT"
WORK=$(mktemp -d)
mkdir -p "$WORK/seedeep" "$WORK/claude/projects"
# bash and the executable have to agree on ONE directory, and on Windows they do not by default: a
# native binary cannot read an MSYS path, and MSYS converts only a fixed set of variables on the way
# out (`PATH`, `HOME`, `TMP`, `TEMP`) - never this one. The executable would resolve `/tmp/…` against
# the current drive, write its run-state record into `C:\tmp\…` and leave bash reading an empty
# `servers/` next to a server that started perfectly. Handing it the Windows form of the same path
# keeps both sides on one directory; `$RECORDS` below stays POSIX, because that is what bash reads.
case "${OSTYPE:-}" in
  msys* | cygwin*)
    SEEDEEP_HOME=$(cygpath -w "$WORK/seedeep")
    CLAUDE_CONFIG_DIR=$(cygpath -w "$WORK/claude")
    ;;
  *)
    SEEDEEP_HOME="$WORK/seedeep"
    CLAUDE_CONFIG_DIR="$WORK/claude"
    ;;
esac
export SEEDEEP_HOME CLAUDE_CONFIG_DIR
RECORDS="$WORK/seedeep/servers"

cleanup() {
  "$BIN" stop --port "$PORT" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "lifecycle: FAIL — $1" >&2
  # The POSIX form, for the reason `$RECORDS` uses it: this is bash reading, not the executable.
  [ -f "$WORK/seedeep/server.log" ] && tail -n 20 "$WORK/seedeep/server.log" >&2
  exit 1
}

# The pids of the servers that have announced themselves on this SEEDEEP_HOME, one per line.
recorded_pids() {
  ls "$RECORDS" 2>/dev/null | sed 's/\.json$//' | grep -E '^[0-9]+$' || true
}

# Wait until `/api/config` answers 200, or give up. Used after `start` and after `restart`, where
# the question is not "did the command exit 0" but "is there a server there now".
answers() {
  local waited=0
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/config" || true)" = 200 ]; do
    waited=$((waited + 1))
    [ "$waited" -lt "$TIMEOUT_S" ] || return 1
    sleep 1
  done
  return 0
}

[ -f "$BIN" ] || fail "no such file: $BIN"
chmod +x "$BIN" 2>/dev/null || true

# 1. start
"$BIN" start --port "$PORT" >"$WORK/start.log" 2>&1 || {
  cat "$WORK/start.log" >&2
  fail "\`start\` did not exit 0"
}
answers || fail "\`start\` exited 0 but nothing answers on $BASE/api/config"
pids=$(recorded_pids)
count=$(printf '%s\n' "$pids" | grep -c . || true)
[ "$count" = 1 ] || fail "expected exactly one run-state record after \`start\`, found $count"
first_pid=$pids
echo "lifecycle: started — pid $first_pid answering on $BASE"

# 2. status
"$BIN" status --port "$PORT" >"$WORK/status.log" 2>&1 || {
  cat "$WORK/status.log" >&2
  fail "\`status\` did not exit 0 against a running server"
}
echo "lifecycle: status OK"

# 3. restart — the port race, which is the whole reason this step exists
"$BIN" restart --port "$PORT" >"$WORK/restart.log" 2>&1 || {
  cat "$WORK/restart.log" >&2
  fail "\`restart\` did not exit 0"
}
answers || fail "\`restart\` exited 0 and left NO replacement answering on $BASE/api/config"
waited=0
until [ "$(recorded_pids | grep -c . || true)" = 1 ]; do
  waited=$((waited + 1))
  [ "$waited" -lt "$TIMEOUT_S" ] || fail "after \`restart\` the run-state records never settled to one"
  sleep 1
done
second_pid=$(recorded_pids)
[ "$second_pid" != "$first_pid" ] ||
  fail "after \`restart\` the recorded pid is still $first_pid — no replacement was spawned"
echo "lifecycle: restarted — pid $first_pid replaced by $second_pid, still answering"

# 4. stop
"$BIN" stop --port "$PORT" >"$WORK/stop.log" 2>&1 || {
  cat "$WORK/stop.log" >&2
  fail "\`stop\` did not exit 0"
}
waited=0
until [ "$(recorded_pids | grep -c . || true)" = 0 ]; do
  waited=$((waited + 1))
  [ "$waited" -lt "$TIMEOUT_S" ] || fail "\`stop\` exited 0 but a run-state record is still there"
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/config" || true)" = 200 ] &&
  fail "\`stop\` exited 0 but the server still answers on $BASE/api/config"

echo "lifecycle: OK — start, status, restart and stop all behaved on $BIN"
