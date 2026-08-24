#!/usr/bin/env bash
# The enforcement half of `.github/workflows/issue-triage.yml`.
#
# This is the body of that workflow's `Decide and act` step, and it lives in a
# file for a mechanical reason: GitHub parses a `run:` block as a single
# expression and refuses the whole workflow file when one exceeds 21000. This
# step's reasoning is longer than that, and an unparseable workflow file fails
# every run with no jobs at all — the loudest possible failure for the quietest
# possible reason.
#
# The units are worth knowing before budgeting against that number. The block
# that broke this workflow held 20,893 bytes over 408 lines and was rejected,
# which is 21,301 with CRLF line endings — so it is the block's own content,
# counted with a carriage return per line, and the usable budget is nearer
# 20,500 bytes than 21,000. GitHub reports the failure as a run named after the
# file path with no jobs; the message naming the line and the limit comes only
# from `gh api repos/OWNER/REPO/actions/workflows/FILE/dispatches`.
#
# Read this as part of that workflow; it takes its whole input from the
# environment that step sets, and nothing here is interpolated by Actions.
set -euo pipefail

# The enforcement layer. Everything above produced claims; this step
# decides, and it decides from the two verdicts plus the API. No prompt
# reaches it, which is the point: the rules in the header comment are
# rules because they are checked here.
#
# Both verdicts are the sessions' structured outputs, read from `env`.
# Each belongs to this run by construction, which is the whole reason
# they are not files: a verdict file left behind by an earlier run on the
# same runner is indistinguishable from this run's, and one saying
# `refuted: false` would have closed an issue on an argument about two
# other issues. The type guards below still run. `--json-schema` has the
# runtime enforce the shape, but a control that only holds while the
# action keeps behaving is not a control.
#
# `type == "object"` and not `jq -e .`, which only asks whether the value
# is JSON at all. A bare `[1,2]` passes that and then `.verdict` on an
# array is a jq *error*, which under `set -e` kills the one step built to
# report on every path — the step would exit non-zero having said nothing,
# which is the failure mode it exists to prevent. The schema makes an
# object, so this is only reachable if the action changes; that is exactly
# the case these guards are for.

VERDICT=""; CANONICAL=""; CONFIDENCE=""; REASON=""; LOST=""; NOTES=""
if [ -n "${FIND_JSON:-}" ] && printf '%s' "$FIND_JSON" | jq -e 'type == "object"' >/dev/null 2>&1; then
  VERDICT=$(printf '%s' "$FIND_JSON" | jq -r '.verdict // ""')
  CANONICAL=$(printf '%s' "$FIND_JSON" | jq -r 'if (.canonical | type) == "number" then (.canonical | tostring) else "" end')
  CONFIDENCE=$(printf '%s' "$FIND_JSON" | jq -r '.confidence // ""')
  REASON=$(printf '%s' "$FIND_JSON" | jq -r '.reason // ""')
  LOST=$(printf '%s' "$FIND_JSON" | jq -r '.lost_if_closed // ""')
  NOTES=$(printf '%s' "$FIND_JSON" | jq -r '.notes // ""')
  # Digits only, for the reason given in `Prepare the refutation`: a
  # `1.5` would make every `-gt` and `-eq` below exit 2 rather than
  # answer, and a chain of accidentally-falsy tests is not a rule. An
  # unusable number becomes no number, which the `-z` branch reports as
  # "no canonical issue was named".
  if ! printf '%s' "$CANONICAL" | grep -qE '^[0-9]+$'; then
    CANONICAL=""
  fi
fi

REFUTED=""; REFUTE_REASON=""
if [ -n "${REFUTE_JSON:-}" ] && printf '%s' "$REFUTE_JSON" | jq -e 'type == "object"' >/dev/null 2>&1; then
  REFUTED=$(printf '%s' "$REFUTE_JSON" | jq -r 'if (.refuted | type) == "boolean" then (.refuted | tostring) else "" end')
  REFUTE_REASON=$(printf '%s' "$REFUTE_JSON" | jq -r '.reason // ""')
fi

# --- The model's prose, on its way to a public comment --------------
# `reason`, `lost_if_closed`, `notes` and the refutation's `reason` are
# free text a model wrote after reading an issue body anyone can open.
# They are the only part of this step that is not re-derived, and they
# get posted to a public issue comment, so whatever a session can read,
# it can publish. Three things happen to them first.
#
# Flattened to one line, so a field cannot forge structure. Markdown
# headings, list items and a `---` rule all read as workflow output
# rather than as quoted input, and the comment puts the workflow's own
# sentences next to these.
#
# Capped. 600 characters is more than an explanation of two issues
# needs, and it stops a runaway field from burying the part of the
# comment this file wrote. Not a security control by itself — an AWS
# access key id is 20 characters — but a bound is a bound. The cap is a
# substring expansion and not `head -c 600`, because `head` in a
# pipeline is a reader that stops early: on a 200,000-character field it
# exits at 600 bytes, the upstream `tr` takes SIGPIPE, and under
# `pipefail` the whole pipeline returns 141, which the assignment
# inherits and `set -e` turns into a dead step. That would kill the one
# step built to report no matter what — including on the paths where an
# issue has already been closed and the comment explaining it has not
# been posted yet. `${s:0:600}` has no pipe and no reader to die on.
# Under a UTF-8 locale it also counts characters rather than bytes, so
# "600 characters" is what it says on em-dash-heavy prose and the cut
# cannot land inside a sequence; if the runner leaves `LANG` unset bash
# falls back to `C` and indexes bytes, which is the old behaviour and at
# worst a replacement character in a comment. Not worth pinning a locale
# for — the cap is a bound on length, not a correctness guarantee.
#
# Redacted against the live credential values, which is the layer that
# is actually reliable. The session that wrote these strings had the
# Bedrock credentials and the token in its process environment; this
# step has the real values and can compare. It catches verbatim
# copying, and it does not catch a value re-encoded on the way out —
# nothing here could. The control for that is upstream, in what the
# session is allowed to read, which is why `Read` is scoped as well.
clean_field() {
  local s
  s=$(printf '%s' "$1" | tr -d '\000' | tr '\n\r\t' '   ')
  printf '%s' "${s:0:600}"
}
redact_field() {
  local s
  s=$(clean_field "$1")
  for v in "${GH_TOKEN:-}" "${AWS_ACCESS_KEY_ID:-}" \
           "${AWS_SECRET_ACCESS_KEY:-}" "${AWS_SESSION_TOKEN:-}"; do
    # 8 is short enough to catch a real value and long enough that an
    # empty or placeholder variable cannot turn every field into
    # `[redacted]`.
    if [ -n "$v" ] && [ "${#v}" -ge 8 ]; then
      s="${s//"$v"/[redacted]}"
    fi
  done
  printf '%s' "$s"
}
REASON=$(redact_field "$REASON")
LOST=$(redact_field "$LOST")
NOTES=$(redact_field "$NOTES")
REFUTE_REASON=$(redact_field "$REFUTE_REASON")

# `verdict` and `confidence` come out of the same model-written file and
# they also reach the posted comment, through the blocker sentences that
# quote them back. They are not sanitized like the prose above, they are
# checked against their allowed values, which is the stronger move where
# it is available: a string outside the enum is not an over-long or
# badly-formatted verdict, it is not a verdict, so there is nothing to
# salvage by trimming it. Anything unrecognised becomes empty — for
# `verdict` that is the branch immediately below, which reports no
# readable verdict and fails the run, and for `confidence` it reads as
# `unstated` and cannot satisfy the `high` gate.
#
# Case and surrounding space are normalised away first, and it is worth
# being straight about what that buys today, because it is less than it
# was written for. It went in to keep a cosmetic slip from costing an
# issue its comment: `Duplicate` discarded here means a failed run and
# nothing posted, indistinguishable from a timeout, for a verdict whose
# meaning was never in doubt. But `--json-schema` pins `verdict` to the
# same three words in the runtime, which sits in front of this: a
# `Duplicate` fails validation there, `$FIND_JSON` arrives empty, and
# the `No verdict` branch below is what runs. So the case the
# normalisation was for cannot reach it while the schema holds, and the
# normalisation earns its place as the layer that still means something
# if the action stops validating — the same reason the type guards above
# run at all. What it does when it is reached: the gates accept one
# *normalised* value, so a `Duplicate` can close rather than merely be
# reported. Nothing between a verdict and a close moves either way — the
# refutation and the four re-derived rules are the same. And it is
# blunt: `tr -d '[:space:]'` drops interior space, so `dup licate`
# normalises in too. Harmless, since a body aiming at a close would just
# write `duplicate`, but not a single accepted spelling.
enum_value() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]'
}
VERDICT=$(enum_value "$VERDICT")
CONFIDENCE=$(enum_value "$CONFIDENCE")
case "$VERDICT" in
  duplicate|related|distinct) ;;
  *)
    [ -z "$VERDICT" ] ||
      echo "::warning::The find session wrote a verdict outside the allowed set; discarding it."
    VERDICT=""
    ;;
esac
case "$CONFIDENCE" in
  high|medium|low) ;;
  *) CONFIDENCE="" ;;
esac

# --- Did anything actually run? -----------------------------------
# This fails the run rather than warning on a green one, and the
# difference matters more than it looks. Every guard above exits 0 with
# a reason, because "not eligible" is a correct outcome. Reaching this
# point is not: the run got past every guard, spent a model call and
# produced nothing readable. This is not hypothetical — the first live run
# of this workflow ended here, because the find session's `Write` was
# denied by a permission rule that looked right, and a workflow that
# triages nothing while reporting success is one nobody discovers is
# broken. Red is how anyone found out. A model timeout lands here too, and
# calling that a failed run is also correct.
if [ -z "$VERDICT" ]; then
  {
    echo
    echo '### No verdict'
    echo
    printf 'The find step ended with outcome `%s` and left no readable verdict, so issue #%s was not triaged. Nothing was changed on it.\n\n' \
      "$FIND_OUTCOME" "$TARGET"
    printf 'If this repeats on every run, suspect the model steps rather than the model: a session whose tools were denied, or whose output failed schema validation, looks exactly like this. The step log for `Claude — find the nearest open issue` reports `permission_denials_count`.\n'
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::error::No verdict for #$TARGET (find outcome=$FIND_OUTCOME) — the issue was not triaged."
  exit 1
fi

# --- Re-derive every gate, in the order they can veto --------------
# Stated as a list of reasons rather than a boolean, because the reason
# is what goes on the issue and into the summary. A `duplicate` verdict
# that is not acted on is not a failure — it is the workflow working —
# and the maintainer reading it needs to know which rule stopped it.
BLOCKERS=""
add_blocker() { BLOCKERS="${BLOCKERS}${BLOCKERS:+; }$1"; }

[ "$VERDICT" = "duplicate" ] || add_blocker "the verdict is \`$VERDICT\`, not \`duplicate\`"
[ "$CONFIDENCE" = "high" ] || add_blocker "confidence is \`${CONFIDENCE:-unstated}\`, and only \`high\` can close"

if [ -z "$CANONICAL" ]; then
  # Not an `A && B` one-liner: it would be the last command in this
  # branch, and a false test there makes the whole `if` return nonzero,
  # which under `set -e` ends the step before anything is reported.
  if [ "$VERDICT" = "duplicate" ]; then add_blocker "no canonical issue was named"; fi
elif [ "$CANONICAL" = "$TARGET" ]; then
  add_blocker "the canonical issue is the issue itself"
  echo "::warning::Verdict named #$TARGET as its own duplicate — ignoring."
elif [ "$CANONICAL" -gt "$TARGET" ]; then
  # Rule 1. Worth an explicit sentence in the summary, because a reader
  # who sees "duplicate of #135" on issue #120 and no close will
  # otherwise assume the workflow is broken.
  add_blocker "#$CANONICAL is newer than #$TARGET, and only the newer issue of a pair may be closed"
elif gh issue view "$CANONICAL" --json state > /tmp/triage/canon-now.json 2>/dev/null \
     && jq -e 'has("state")' /tmp/triage/canon-now.json >/dev/null 2>&1; then
  CANON_STATE=$(jq -r '.state' /tmp/triage/canon-now.json)
  [ "$CANON_STATE" = "OPEN" ] || add_blocker "#$CANONICAL is \`$CANON_STATE\`, not an open issue"
else
  add_blocker "#$CANONICAL could not be re-read to confirm it is still open"
fi

# Rules 2, 3 and 4, re-checked. The preflight already stopped the run for
# a claim or a human comment, but that read happened before two model
# sessions, and a PR or a comment can land inside that window — which is
# exactly when closing the issue does the most damage.
# Every read below goes to a file and is validated before it is believed.
# `gh` prints an API error body to *stdout*, so the obvious
# `X=$(gh ... || true)` does not leave X empty on failure — it fills X
# with `{"message":"Not Found",...}`. Which direction that breaks in
# depends on the check, and one of them broke silently in the permissive
# direction, so all of them now read the same way: a failed read is not a
# clean bill of health, it is a blocker. An issue this step cannot
# confirm is open, unclaimed, unlabelled and unanswered does not get
# closed.
#
# The reads are also two commands each rather than one, because
# `gh --jq` takes no `--argjson`.
if gh pr list --state open --limit 200 \
     --json number,headRefName,closingIssuesReferences \
     > /tmp/triage/open-prs-now.json 2>/dev/null \
   && jq -e 'type == "array"' /tmp/triage/open-prs-now.json >/dev/null 2>&1; then
  RECHECK_CLAIM=$(jq -r --argjson n "$TARGET" '
    [ .[] | select(
        ( [ (.closingIssuesReferences[]?.number) ]
          + (.headRefName | [ scan("(?:^|[^a-zA-Z])issue-([0-9]+)") | (.[0] | tonumber) ])
        ) | index($n) )
      | "#\(.number)" ] | join(", ")' /tmp/triage/open-prs-now.json)
  [ -z "$RECHECK_CLAIM" ] || add_blocker "open PR $RECHECK_CLAIM now claims this issue"
else
  add_blocker "the open pull requests could not be re-read, so it is unknown whether one now claims this issue"
fi

RECHECK_FILER=""
if gh issue view "$TARGET" --json state,labels,author > /tmp/triage/target-now.json 2>/dev/null \
   && jq -e 'has("state")' /tmp/triage/target-now.json >/dev/null 2>&1; then
  RECHECK_STATE=$(jq -r '.state' /tmp/triage/target-now.json)
  RECHECK_FILER=$(jq -r '.author.login // ""' /tmp/triage/target-now.json)
  RECHECK_LABELS=$(jq -r '[.labels[].name]
    | map(select(. == "no-auto-close" or . == "duplicate")) | join(", ")' \
    /tmp/triage/target-now.json)
  [ "$RECHECK_STATE" = "OPEN" ] || add_blocker "the issue is now \`$RECHECK_STATE\`"
  [ -z "$RECHECK_LABELS" ] || add_blocker "the issue now carries \`$RECHECK_LABELS\`"
else
  add_blocker "issue #$TARGET could not be re-read to confirm it is still open and unlabelled"
fi

# Rule 3, re-checked here and not only in the preflight — and this one
# matters more than the symmetry does, because it is the assertion the
# close comment makes on the issue itself. Checked only in the preflight,
# "nobody has replied to it" was a statement about a read taken *before*
# two model sessions ran, and the minutes those sessions take are exactly
# when somebody answers a freshly-filed issue. A reply landing in that
# window is a person engaging with the report, which is the case rule 3
# exists for; closing over it is how an automation gets muted.
#
# Same failure posture as the reads above: a comment list this step
# cannot read blocks the close rather than passing it. The filer comes
# from the re-read, so if that read failed `$RECHECK_FILER` is empty, no
# login is excluded, and the filer's own follow-up blocks too — the
# cautious direction, which is the one to fail in.
#
# `$GITHUB_REPOSITORY` is the runner's own variable, not one this workflow
# sets and not anything a model wrote — the same value Actions would have
# substituted for `github.repository` when this was an inline block.
if gh api "repos/$GITHUB_REPOSITORY/issues/$TARGET/comments" --paginate \
     --jq '.[] | [(.user.login // ""), (.body // "")] | @tsv' \
     > /tmp/triage/target-comments-now.tsv 2>/dev/null; then
  RECHECK_COMMENTERS=$(awk -F'\t' -v filer="$RECHECK_FILER" '
    $1 == "" { next }
    filer != "" && $1 == filer { next }
    $1 ~ /\[bot\]$/ { next }
    $1 == "Rogue-Git-Dev" { next }
    { print $1 }' /tmp/triage/target-comments-now.tsv | sort -u | paste -sd' ' -)
  if [ -n "$RECHECK_COMMENTERS" ]; then
    add_blocker "$RECHECK_COMMENTERS replied to this issue while it was being triaged"
  fi
else
  add_blocker "the comments on this issue could not be re-read, so it is unknown whether a person has replied to it"
fi

# The refutation. A missing or unparseable file blocks the close rather
# than defaulting to it: the second session is a requirement, not an
# enhancement, so "it did not run" and "it refuted" have to mean the
# same thing here.
if [ "${DID_REFUTE:-false}" != "true" ]; then
  add_blocker "no refutation session ran"
elif [ -z "$REFUTED" ]; then
  add_blocker "the refutation session left no readable verdict (outcome \`$REFUTE_OUTCOME\`)"
  echo "::warning::Refutation produced no verdict for #$TARGET — not closing."
elif [ "$REFUTED" = "true" ]; then
  add_blocker "the independent session refuted the duplicate claim"
fi

# --- Compose the record both outcomes share ------------------------
BODY=/tmp/triage/comment.md
{
  printf '%s\n' "$MARKER"
} > "$BODY"

if [ -z "$BLOCKERS" ]; then
  # ---- Close ----------------------------------------------------
  {
    printf '**Closed as a duplicate of #%s.**\n\n' "$CANONICAL"
    printf 'Two sessions read this independently: one found #%s to be the same issue, and a second — shown only the two issues, told to argue against closing — could not find anything this issue asks for that #%s does not.\n\n' \
      "$CANONICAL" "$CANONICAL"
    printf '> %s\n\n' "$REASON"
    printf 'If that is wrong, **reopen this issue and say what #%s misses.** ' "$CANONICAL"
    printf 'A reopened issue is not triaged again, so it will stay open.\n\n'
    printf -- '---\n\n'
    printf 'Closed by the `issue-triage` workflow ([run](%s)). ' "$RUN_URL"
    printf 'It closes an issue only when it is the newer of the pair, nothing links a pull request to it, and nobody other than its author has replied to it — each of those re-checked against the API immediately before this comment was posted.\n'
  } >> "$BODY"

  if [ "${DRY_RUN:-false}" = "true" ]; then
    {
      echo
      printf '### Dry run — would have closed #%s as a duplicate of #%s\n\n' "$TARGET" "$CANONICAL"
      printf 'Nothing was changed. The comment it would have posted:\n\n'
      printf -- '---\n\n'
      cat "$BODY"
    } >> "$GITHUB_STEP_SUMMARY"
    echo "::notice::DRY RUN: #$TARGET would have been closed as a duplicate of #$CANONICAL."
    exit 0
  fi

  # Comment before closing. If the close fails, an issue with an
  # explanatory comment and no state change is a small confusion; a
  # closed issue with no explanation on it is the outcome that makes
  # people distrust the automation.
  gh issue comment "$TARGET" --body-file "$BODY"
  # The label as well as the state: `issue-to-pr.yml` reads `duplicate`
  # to keep the issue out of its build queue, and it reads labels, not
  # state reasons.
  gh issue edit "$TARGET" --add-label duplicate \
    || echo "::warning::could not add the 'duplicate' label to #$TARGET"
  # `not planned`, because GitHub offers no `duplicate` close reason and
  # `completed` would be a lie — nothing was completed. The comment and
  # the label carry the actual reason.
  gh issue close "$TARGET" --reason "not planned"

  {
    echo
    printf '### Closed [#%s](%s/issues/%s) as a duplicate of [#%s](%s/issues/%s)\n\n' \
      "$TARGET" "$REPO_URL" "$TARGET" "$CANONICAL" "$REPO_URL" "$CANONICAL"
    printf '%s\n\n' "$REASON"
    printf 'Refutation attempt: %s\n' "${REFUTE_REASON:-(none recorded)}"
    # `if`, not `&&`: this is the last command in the group, and under
    # `set -e` a failed test there would abort the step *after* the
    # issue was already closed — reporting nothing about a close that
    # did happen. Same reason everywhere else in this file.
    if [ -n "$NOTES" ]; then printf '\nNotes: %s\n' "$NOTES"; fi
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::notice::Closed #$TARGET as a duplicate of #$CANONICAL."
  exit 0
fi

# ---- Report, do not close ---------------------------------------
# Every non-close ends here, and only the ones with something to say
# get a comment. A note on every distinct issue would train people to
# ignore the workflow, and the noise would fall hardest on the tracker
# this repo files 26 issues a week into.
{
  echo
  printf '### Not closed — #%s stays open\n\n' "$TARGET"
  printf 'Verdict `%s`' "$VERDICT"
  if [ -n "$CANONICAL" ]; then printf ' against [#%s](%s/issues/%s)' "$CANONICAL" "$REPO_URL" "$CANONICAL"; fi
  printf ', confidence `%s`.\n\n' "${CONFIDENCE:-unstated}"
  printf 'Why it was not closed: %s.\n\n' "$BLOCKERS"
  printf '%s\n' "$REASON"
  if [ -n "$LOST" ]; then printf '\nWould be lost by closing: %s\n' "$LOST"; fi
  if [ -n "$REFUTE_REASON" ]; then printf '\nRefutation: %s\n' "$REFUTE_REASON"; fi
  if [ -n "$NOTES" ]; then printf '\nNotes: %s\n' "$NOTES"; fi
} >> "$GITHUB_STEP_SUMMARY"

if [ -z "$CANONICAL" ] || [ "$CANONICAL" = "$TARGET" ]; then
  # Nothing to point a reader at, so there is nothing worth a comment.
  echo "::notice::#$TARGET looks distinct — no comment posted. $BLOCKERS"
  exit 0
fi

{
  printf '**Possibly a duplicate of #%s — left open for a human.**\n\n' "$CANONICAL"
  printf '> %s\n\n' "$REASON"
  if [ -n "$LOST" ] && [ "$LOST" != "nothing" ]; then
    printf 'What closing this would lose: %s\n\n' "$LOST"
  fi
  if [ -n "$REFUTE_REASON" ]; then
    printf 'A second session, told to argue against closing, said: %s\n\n' "$REFUTE_REASON"
  fi
  if [ -n "$NOTES" ]; then printf '%s\n\n' "$NOTES"; fi
  printf 'Not closed because %s.\n\n' "$BLOCKERS"
  printf -- '---\n\n'
  printf 'Posted by the `issue-triage` workflow ([run](%s)). ' "$RUN_URL"
  printf 'It closes duplicates only when two independent sessions agree; this one did not qualify, so the call is yours. '
  printf 'Add `no-auto-close` if this issue should never be closed automatically.\n'
} >> "$BODY"

if [ "${DRY_RUN:-false}" = "true" ]; then
  {
    echo
    printf 'Dry run — the comment it would have posted on #%s:\n\n' "$TARGET"
    printf -- '---\n\n'
    cat "$BODY"
  } >> "$GITHUB_STEP_SUMMARY"
  echo "::notice::DRY RUN: #$TARGET would have been commented on as a possible duplicate of #$CANONICAL."
  exit 0
fi

gh issue comment "$TARGET" --body-file "$BODY"
echo "::notice::#$TARGET left open, flagged as a possible duplicate of #$CANONICAL. $BLOCKERS"
