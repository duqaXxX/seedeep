#!/usr/bin/env bash
#
# New I/O surface scan for the seedeep repo.
#
# Reads a unified diff on stdin and fails if an ADDED line under apps/server/src/ introduces a way
# to reach the network or start a process, in a file that does not already hold one.
#
#   git diff <base>..<head> | .github/scripts/scan-new-io-surface.sh
#
# Exit 0 = clean, 1 = a new surface appeared.
#
# Why this is a gate and not a reviewer's job. seedeep is public, it takes pull requests from forks,
# and its architecture invariant is that it READS local session logs: nothing in the reading path
# has any business opening a socket or spawning a binary. Checking that by hand works right up until
# the reviewer is busy, and a fork's workflows now run here without an approval click once its
# author has one merge. Measured over the 60 commits before this was written, it would have fired
# 0 times, so a hit is something genuinely new rather than routine work.
#
# ALLOWED is a file list and not a pattern on purpose: growing it is a decision somebody makes
# deliberately, in a diff a reviewer can see.

set -euo pipefail

ALLOWED='apps/server/src/client/auth.ts
apps/server/src/client/deadline.ts
apps/server/src/server/browser.ts
apps/server/src/server/command-liveness.ts
apps/server/src/server/git.ts
apps/server/src/server/open-cmd.ts
apps/server/src/server/own-server.ts
apps/server/src/server/restart-cmd.ts
apps/server/src/server/self-update-cmd.ts
apps/server/src/server/server.ts
apps/server/src/server/session-launch.ts
apps/server/src/server/tls.ts'

# A bare `exec(` is absent on purpose: RegExp.prototype.exec accounts for 37 call sites here, and a
# gate that flags those is a gate people bypass. execFile, child_process and Bun.spawn cover the
# process side without it.
PATTERN='fetch\(|Bun\.spawn|child_process|execFile|eval\(|new Function'

file=''
findings=''

while IFS= read -r line; do
  case "$line" in
    '+++ b/'*)
      file="${line#+++ b/}"
      continue
      ;;
    '+++'*)
      file=''
      continue
      ;;
    '+'*) ;;
    *) continue ;;
  esac

  [ -n "$file" ] || continue
  case "$file" in
    apps/server/src/*.ts) ;;
    *) continue ;;
  esac
  if printf '%s\n' "$ALLOWED" | grep -qxF -- "$file"; then continue; fi

  if printf '%s' "${line#+}" | grep -qE -- "$PATTERN"; then
    findings="${findings}  - ${file}: $(printf '%s' "${line#+}" | sed 's/^[[:space:]]*//' | cut -c1-90)"$'\n'
  fi
done

if [ -n "$findings" ]; then
  {
    echo ''
    echo 'New I/O surface scan BLOCKED these changes:'
    printf '%s' "$findings"
    echo ''
    echo '  These lines open a network or process surface in a file that had none. seedeep reads'
    echo '  local files; it does not fetch or spawn. If the change genuinely needs one, add the'
    echo '  file to ALLOWED in .github/scripts/scan-new-io-surface.sh in the same pull request and'
    echo '  say in the description what it talks to and why.'
    echo ''
  } >&2
  exit 1
fi

echo 'New I/O surface scan: clean.'
