#!/usr/bin/env bash
#
# Does a built server executable actually RUN — on a machine that did not build it?
#
# All six executables are cross-compiled from one `ubuntu-latest` runner, so until this ran, the
# Windows binary and both Linux ARM binaries had never been EXECUTED anywhere, ever. That is the
# 0.6.0 shape: green artefacts, dead at startup on every machine but the builder's.
#
#   .github/scripts/smoke-server.sh <binary> <expected-version> [port]
#
# It asserts three things, in the order they can break:
#
#   1. `--version` prints the expected number — the binary loads and its embedded version is the
#      one being released (a forgotten bump fails here, not on someone's machine).
#   2. `GET /api/config` answers 200 — the one endpoint that needs no auth token and no session on
#      disk, so it is a true "the server is up" and nothing else.
#   3. `GET /`, `/lib/app.js` and `/css/chrome.css` answer 200 — the GUI is really inside the
#      executable. This is not paranoia: `apps/server/src/server/assets.ts` records the measured
#      failure where `/api/*` answered and every static path 404'd, because `bun build --compile`
#      embeds a file only when something imports it. A smoke test that only called `/api` would
#      have shipped that.
#
# `SEEDEEP_HOME` and `CLAUDE_CONFIG_DIR` are pointed at a temporary directory, so a run touches
# neither the config nor the sessions of the machine it runs on — which is what makes it safe to
# run on a laptop and not only on a throwaway runner.
#
# Bash on every platform, never PowerShell: v0.6.0 uploaded no Windows installer because `"$TAG"`
# in PowerShell is an unassigned variable that expands to nothing. One shell, one script, six
# platforms.

set -euo pipefail

BIN=${1:?usage: smoke-server.sh <binary> <expected-version> [port]}
EXPECTED=${2:?usage: smoke-server.sh <binary> <expected-version> [port]}
# Not the default 44842: a smoke test must never talk to a seedeep the machine is already running,
# nor make one adopt its throwaway config.
PORT=${3:-44899}
# Seconds to wait for the first answer. Overridable so the test suite can drive the failure paths
# without waiting out a real startup budget.
TIMEOUT_S=${SMOKE_TIMEOUT_S:-60}

BASE="http://127.0.0.1:$PORT"
WORK=$(mktemp -d)
export SEEDEEP_HOME="$WORK/seedeep"
export CLAUDE_CONFIG_DIR="$WORK/claude"
mkdir -p "$CLAUDE_CONFIG_DIR/projects"

PID=""
cleanup() {
  if [ -n "$PID" ]; then kill "$PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "smoke: FAIL — $1" >&2
  exit 1
}

[ -f "$BIN" ] || fail "no such file: $BIN"
chmod +x "$BIN" 2>/dev/null || true

# 1. The binary loads at all, and knows which version it is.
# `tr -d '\r'` because Git Bash on Windows reads a native program's output verbatim, CR included.
version=$("$BIN" --version 2>"$WORK/version.err" | tr -d '\r') || {
  cat "$WORK/version.err" >&2
  fail "\`$BIN --version\` did not exit 0 — the executable does not start on this machine"
}
[ "$version" = "$EXPECTED" ] || fail "--version printed '$version', expected '$EXPECTED'"

# 2. It serves. `--no-open` because a runner has no browser, and opening one would be the only
# step here that needs a desktop.
"$BIN" serve --port "$PORT" --no-open >"$WORK/serve.log" 2>&1 &
PID=$!

waited=0
until [ "$(curl -s -o "$WORK/config.json" -w '%{http_code}' "$BASE/api/config" || true)" = 200 ]; do
  kill -0 "$PID" 2>/dev/null || {
    cat "$WORK/serve.log" >&2
    fail "the server exited before answering — see its output above"
  }
  waited=$((waited + 1))
  [ "$waited" -lt "$TIMEOUT_S" ] || {
    cat "$WORK/serve.log" >&2
    fail "no answer on $BASE/api/config after ${TIMEOUT_S}s"
  }
  sleep 1
done

grep -q '"port"' "$WORK/config.json" || fail "/api/config answered 200 but its body is not the config"

# 3. The GUI is in there. One file per kind — the HTML the browser asks for at `/`, the script
# bundle, one stylesheet — because they are all embedded by the same `with { type: 'file' }`
# mechanism and it fails for all of them at once.
for path in / /lib/app.js /css/chrome.css; do
  code=$(curl -s -o "$WORK/asset" -w '%{http_code}' "$BASE$path" || true)
  [ "$code" = 200 ] || fail "GET $path answered $code — the browser GUI is not inside this executable"
  [ -s "$WORK/asset" ] || fail "GET $path answered 200 with an empty body"
done

echo "smoke: OK — $BIN $version starts, serves /api/config, and carries the GUI"
