#!/usr/bin/env bash
#
# Sensitive-data scan for the seedeep repo.
#
# Reads a unified diff on stdin and fails if any ADDED line looks like private data. The repo is
# public: a leak committed once stays in the history forever, so this runs in CI on every push and
# pull request, where a fork inherits it — a local git hook cannot, since `.git/` is untracked.
#
#   git diff <base>..<head> | .github/scripts/scan-sensitive-diff.sh
#
# Exit 0 = clean, 1 = something matched. High-confidence patterns only: a gate that cries wolf is
# a gate people bypass.
#
# The patterns below are written so the script cannot match ITSELF — `/[U]sers` matches the real
# path but not this line. Do not "simplify" those brackets away.

set -euo pipefail

added="$(grep '^+' | grep -v '^+++' || true)"
[ -z "$added" ] && exit 0

findings=""
flag() { findings="${findings}  - $1"$'\n'; }

# Real home paths leak the machine's user. /home/dev is the neutral placeholder the docs use.
echo "$added" | grep -E '/[U]sers/[a-zA-Z]|/[h]ome/[a-zA-Z]' | grep -vE '/[h]ome/dev' >/dev/null 2>&1 \
  && flag 'real home path (/Users/... or /home/...) — use a neutral placeholder'

# Personal email addresses. Asset filenames are excluded: '@' is idiomatic in them, and
# 'icons/128x128@2x.png' matches the address shape exactly.
echo "$added" | grep -E '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' \
  | grep -vE 'users\.noreply\.github\.com|@anthropic\.com|example\.(com|org)|@[a-zA-Z0-9.-]*\.(png|jpe?g|gif|svg|webp|ico|icns|woff2?|ttf|css|js)\b' >/dev/null 2>&1 \
  && flag 'email address — remove or use a noreply/example address'

# Secret markers.
echo "$added" | grep -E 'BEG[I]N (RSA|OPENSSH|EC|PGP) PRIVATE KEY|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}' >/dev/null 2>&1 \
  && flag 'possible secret / private key / token'

# References to the private issue tracker: keys, URLs, workspace slugs.
echo "$added" | grep -E 'PLU-[0-9]+|SE[E]-[0-9]+|linear[.]app' >/dev/null 2>&1 \
  && flag 'issue-tracker reference — describe the change, not the ticket'

if [ -n "$findings" ]; then
  {
    echo ""
    echo "Sensitive-data scan BLOCKED these changes:"
    printf '%s' "$findings"
    echo ""
    echo "  Fix the files. If you are certain it is a false positive, say so in the pull request."
    echo ""
  } >&2
  exit 1
fi

echo "Sensitive-data scan: clean."
