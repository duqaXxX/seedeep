#!/usr/bin/env bash
#
# Does the server SURVIVE being started, when nothing touches it?
#
# The smoke gate proves a binary starts and answers once — seconds of work. It cannot see a process
# that dies at t+11s, because by then the gate has already passed. That death is real and measured:
# on a Windows 11 arm64 VM the `windows-x64` binary, running under Prism emulation, was killed
# `0xC0000005` three times in eight starts, at about t+11s, with nothing on stdout or stderr. The
# same source compiled for arm64 survived ten of ten on the same machine, which is why the fault was
# attributed to the emulator — an attribution nobody had measured.
#
#   .github/scripts/idle-survival.sh <binary> [attempts] [idle-seconds] [port]
#
# Each attempt starts the server and then does NOTHING for the idle window, polling only whether the
# process is still there. That is what separates the two stories the same numbers fit:
#
#   dies during the idle window        -> a startup path is at fault; no request was ever sent.
#   survives idle, dies once hit       -> the request path is at fault.
#   survives both                      -> a healthy start.
#
# It reports the COUNT, never the first death: "3 of 8" is the finding, and a script that stopped at
# the first one could not tell it from "1 of 8". A single death fails the run.
#
# `SEEDEEP_HOME` and `CLAUDE_CONFIG_DIR` are pointed at a temporary directory, so a run touches
# neither the config, the sessions, nor the running-server records of the machine it runs on.
#
# Bash on every platform, never PowerShell — the reason is in `smoke-server.sh`, and it is the same
# reason: one shell, one script, no per-OS dialect to get wrong.

set -uo pipefail

BIN=${1:?usage: idle-survival.sh <binary> [attempts] [idle-seconds] [port]}
ATTEMPTS=${2:-10}
# 40 seconds because the deaths measured on arm64 landed at ~t+11s, and the window has to sit well
# past that to be evidence rather than a coin toss. It is also the number the manual arm64 session
# used, so the two runs stay comparable.
IDLE_S=${3:-40}
# Not 44842 (the default) and not 44899 (the smoke script): a survival run must never talk to a
# seedeep the machine is already running, nor to a smoke test sharing the same runner.
PORT=${4:-44898}
# Seconds to wait for the first answer once the idle window is over.
TIMEOUT_S=${IDLE_TIMEOUT_S:-30}
# Seconds between attempts, so the next start does not race the previous socket's close. Overridable
# so the test suite can drive the failure paths without waiting out a real one.
SETTLE_S=${IDLE_SETTLE_S:-2}

BASE="http://127.0.0.1:$PORT"
WORK=$(mktemp -d)
mkdir -p "$WORK/seedeep" "$WORK/claude/projects"
# The Windows form on Windows, or the executable resolves this MSYS path against the current drive
# and writes its state into `C:\tmp\…` instead - isolation that silently is not one. MSYS converts
# only a fixed set of variables on the way out, and neither of these is in it. The lifecycle script
# has the same block for a sharper reason: there, bash reads back what the executable wrote.
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

PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -f "$BIN" ] || {
  echo "idle-survival: FAIL — no such file: $BIN" >&2
  exit 1
}
chmod +x "$BIN" 2>/dev/null || true

deaths=0
died_idle=0
died_on_request=0
never_answered=0

echo "idle-survival: $ATTEMPTS attempts, ${IDLE_S}s idle window each, on $BIN"

for attempt in $(seq 1 "$ATTEMPTS"); do
  log="$WORK/attempt-$attempt.log"
  "$BIN" serve --port "$PORT" --no-open >"$log" 2>&1 &
  PID=$!

  # Phase A: touch nothing. A request in flight would make an innocent bystander of itself.
  waited=0
  alive=1
  while [ "$waited" -lt "$IDLE_S" ]; do
    sleep 1
    waited=$((waited + 1))
    if ! kill -0 "$PID" 2>/dev/null; then
      wait "$PID"
      code=$?
      echo "idle-survival: attempt $attempt DIED WHILE IDLE at t+${waited}s, exit $code — no request was ever sent"
      tail -n 5 "$log" >&2 || true
      deaths=$((deaths + 1))
      died_idle=$((died_idle + 1))
      alive=0
      break
    fi
  done

  if [ "$alive" = 1 ]; then
    # Phase B: now hit it. `/api/config` for the reason the smoke script gives — no token, no session
    # on disk, so a non-answer means the server and nothing else.
    answered=0
    tries=0
    while [ "$tries" -lt "$TIMEOUT_S" ]; do
      if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/config" || true)" = 200 ]; then
        answered=1
        break
      fi
      kill -0 "$PID" 2>/dev/null || break
      tries=$((tries + 1))
      sleep 1
    done

    if ! kill -0 "$PID" 2>/dev/null; then
      wait "$PID"
      code=$?
      echo "idle-survival: attempt $attempt survived ${IDLE_S}s idle then DIED ON THE FIRST REQUEST, exit $code"
      tail -n 5 "$log" >&2 || true
      deaths=$((deaths + 1))
      died_on_request=$((died_on_request + 1))
    elif [ "$answered" = 0 ]; then
      echo "idle-survival: attempt $attempt is alive but never answered $BASE/api/config in ${TIMEOUT_S}s"
      tail -n 5 "$log" >&2 || true
      deaths=$((deaths + 1))
      never_answered=$((never_answered + 1))
      kill "$PID" 2>/dev/null || true
    else
      echo "idle-survival: attempt $attempt OK — alive after ${IDLE_S}s of nothing, then answered 200"
      kill "$PID" 2>/dev/null || true
    fi
  fi

  wait "$PID" 2>/dev/null || true
  PID=""
  # The successor binds the same port: a socket still closing is an EADDRINUSE the next attempt
  # would report as a death that never happened.
  sleep "$SETTLE_S"
done

survived=$((ATTEMPTS - deaths))
echo "idle-survival: $survived/$ATTEMPTS survived — $died_idle died idle, $died_on_request died on the first request, $never_answered never answered"

[ "$deaths" -eq 0 ] || exit 1
