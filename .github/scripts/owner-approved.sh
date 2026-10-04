#!/usr/bin/env bash
# Usage: owner-approved.sh <issue number>
#
# Exits 0 and prints the owner's login when an owner in .github/owners put the `maintainer` label
# on the issue and it is still there. Exits 1 otherwise, including when the events can't be read.
#
# Only accounts with triage access or higher can label an issue. The label event's actor is checked
# too, because that access is wider than the owners list.
set -euo pipefail

n="$1"
repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
owners_file="$(dirname "$0")/../owners"

last=$(gh api --paginate "repos/$repo/issues/$n/events" \
  | jq -r '.[] | select((.event == "labeled" or .event == "unlabeled") and .label.name == "maintainer")
                | "\(.event) \(.actor.login)"' \
  | tail -n 1)

case "$last" in
  "labeled "*) login="${last#labeled }" ;;
  *) exit 1 ;;
esac

if grep -v '^[[:space:]]*#' "$owners_file" | grep -qxF "$login"; then
  echo "$login"
  exit 0
fi
exit 1
