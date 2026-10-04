#!/usr/bin/env bash
# Usage: ask-owners.sh <issue number>
#
# Tags the owners in .github/owners once on an open issue that no owner has labelled `maintainer`,
# so they can decide whether the maintainer should work on it. Posts nothing on a closed issue, on
# one labelled `maintainer` or with one of issue-to-pr.yml's SKIP_LABELS, or on one it already asked on.
set -euo pipefail

n="$1"
here="$(dirname "$0")"
marker='<!-- iris-ask-owners:v1 -->'

gh issue view "$n" --json state,labels,comments > /tmp/ask-owners.json
if [ "$(jq -r .state /tmp/ask-owners.json)" != "OPEN" ]; then
  echo "#$n is not open — not asking."
  exit 0
fi
skip=$(jq -r '[.labels[].name] | map(select(IN("maintainer", "wontfix", "invalid", "duplicate", "question", "no-auto-pr"))) | join(", ")' /tmp/ask-owners.json)
if [ -n "$skip" ]; then
  echo "#$n is labelled $skip — not asking."
  exit 0
fi
if jq -e --arg m "$marker" 'any(.comments[]; .body | contains($m))' /tmp/ask-owners.json >/dev/null; then
  echo "#$n was already asked on — not asking again."
  exit 0
fi

owners=$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$here/../owners" | sed 's/^/@/' | paste -sd' ' -) || true
if [ -z "$owners" ]; then
  echo ".github/owners lists no one — not asking."
  exit 0
fi
{
  printf '%s: this issue is ready for an owner to review. The maintainer works on it only after an owner adds the `maintainer` label.\n\n' "$owners"
  printf '%s\n' "$marker"
} > /tmp/ask-owners.md
gh issue comment "$n" --body-file /tmp/ask-owners.md
