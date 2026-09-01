# The Markdown body of every issue `.github/workflows/quality-report.yml` files
# (PRD §7.16). One finding from that workflow's threshold step arrives on stdin, the whole
# `GET /v1/quality` tally arrives as `--slurpfile tallyfile`, and this prints the body of
# the issue to open for it. Called once per finding, with `--arg url` and
# `--argjson cooldown` as well.
#
# A FILE rather than an inline `run:` block, for the reason
# `.github/scripts/triage-decide.sh` is one: GitHub parses each `run:` as a single
# expression and refuses the whole workflow file past 21,000 characters. With this program
# inline the filing step was 18,173 of those (87%), and 13,000 of it was this — so the
# budget was being spent by the part of the workflow most likely to keep growing, since
# every finding this report learns to explain is another paragraph of prose.
# `test/workflow-run-length.test.ts` prints any block past 85% on every test run; that is
# the warning this answers.
#
# Two things were true only while it was inline and are worth not reintroducing:
#
#   - a literal apostrophe had to be written `'`, because the program sat inside a
#     single-quoted shell argument. In here an apostrophe is an apostrophe.
#   - the job now needs the repository on disk, where it needed nothing before. The
#     checkout is sparse — `.github/scripts` only — and the step after it runs this
#     program once on every run to prove the file arrived and compiles. Without that,
#     a checkout that fetched nothing would fail on the week a threshold is crossed,
#     which is the one week this workflow does anything at all.
#
# `test/quality-report-workflow.test.ts` runs this program against a fixture tally for
# every finding key the workflow can emit, on every `npm test`. That is where a syntax
# error is caught. Nothing else would: this file is read by jq on a Saturday, in a job
# nobody is watching, only on the weeks the deployment has something to say.
#
# What may be printed from here is constrained at the source. Every field of the tally is
# an aggregate by construction (`src/routes/quality.ts`), because the issues this writes
# are public and the documents behind the numbers are user uploads — at the reference
# deployment, student records. A field carrying model-written prose or document text could
# not be printed here even in a count's explanation, which is why the `unresolved`
# finding below says out loud that only the count is available.

($tallyfile[0]) as $tally
# One decimal place, via round rather than by multiplying by 100. These
# are IEEE doubles: 0.15 * 100 is 15.000000000000002, and a threshold
# printed that way in an issue body reads as a mistake even though the
# comparison behind it was correct.
| def pct: (. * 1000 | round) / 10;
(if .rule then
    "Over the last \($tally.window_days) days, **\(.rule_documents) of \($tally.documents_linted) documents that were linted at all** (\(.value | pct)%) came out of Iris still violating the axe-core rule `\(.rule)` — \(.nodes) offending element(s) in total. Impact: **\(.impact)**.\n\nThe threshold is \(.threshold | pct)% of the documents that were linted — the same denominator as the share above, which counts only the documents axe-core could examine.\n\nA rule that fails on this share of documents is a property of how Iris writes HTML, not of the documents people upload. The likely places to look:\n\n- `agents/page.md` and the specialist agents in `agents/` — these files *are* the prompts, so a rule Iris keeps breaking usually means the prompt never told it not to.\n- `agents/copy_editor.md` and `agents/reader.md` — the review loop is meant to catch exactly this and evidently is not; worth asking whether the reader reports it and the editor fails to fix it, or the reader never mentions it at all.\n- `src/pipeline/lint.ts` for what the rule actually checks.\n\nRule reference: <https://dequeuniversity.com/rules/axe/4.10/\(.rule)>"
  else
    {
      # Parenthesised as a whole, because a jq object VALUE does not accept an
      # unparenthesised `+`: `{a: "x" + "y"}` is a syntax error where
      # `{a: ("x" + "y")}` is fine. Worth a note because this program runs only
      # on a week a threshold is crossed, so a syntax error here would sit
      # unnoticed until the run that had something to say.
      "lint-error": ("Over the last \($tally.window_days) days, **\(.value | pct)% of \($tally.documents) documents** had a lint pass that errored instead of running.\n\nThe threshold is \(.threshold | pct)% — that is, any occurrence at all.\n\nThis one sorts to the top because those documents have **no accessibility verdict at all**: axe-core could not run on them, so nothing in them was checked, the review loop had no violations to act on, and they were delivered with an `@lint-unavailable` comment saying so. They are excluded from `documents_linted` (\($tally.documents_linted) of \($tally.documents) here), so the rule shares in this report are not dragged down by them — but the unchecked documents were still shipped, and how bad they were is unknown.\n\n"
        # Which step failed, from the tally rather than from a session log — the
        # detail this body used to send the reader to the deployment for, which
        # is where the documents are and so is the one place a maintainer cannot
        # go (#263). Written from the field when the deployment has it, and the
        # sentence is skipped entirely rather than printed as three zeroes when
        # it does not: an older deployment recorded no step, and "0 parse, 0
        # inject, 0 run" beside a non-zero rate reads as a contradiction.
        + (if ($tally.lint_error_where // []) | length > 0 then
             "**Which step failed:** "
             + ([$tally.lint_error_where[] | "`\(.where)` \(.documents)"] | join(", "))
             + ". `parse` is jsdom refusing the assembled HTML, `inject` is axe's own source failing to evaluate (a dependency problem — it cannot depend on the document), `run` is the rule pass throwing while it walks the document. Those three point at three different fixes. A sum below the \(.value * $tally.documents | round) document(s) in the rate is documents linted before this breakdown was recorded, not a fourth kind of failure.\n\n"
           else "" end)
        + "Start with `src/pipeline/lint.ts` and the `iris:lint-error` signal recorded in `src/pipeline/orchestrator.ts`. A `run` failure has one known cause, fixed in #257: an attribute name the selector engine cannot compile took the whole rule set offline, and the lint now drops those names from its own copy of the document and counts them as `malformed_attributes_removed`. If `run` is what this report names and that fix is deployed, it is a NEW cause — the run log for an affected session carries the error, its stack and where it happened, on the `assembly` line or on a `lint_unavailable` line if a correction round is what broke it."),
      "links-dropped": "Over the last \($tally.window_days) days, **\(.value | pct)% of \($tally.documents) documents** lost at least one hyperlink between the assembled HTML and what the copy editor returned.\n\nThe threshold is \(.threshold | pct)% of documents.\n\nThis is content loss rather than imperfect output: the link was in the user's source document, Iris had it, and the delivered HTML does not. The editor is a text model rewriting a fragment, so dropping an `href` while otherwise improving the prose around it is a plausible failure — and one the loop currently records (`editor_links_dropped`) without preventing.\n\nWhere to look: `droppedHrefs` and its caller in `src/pipeline/review.ts` for how it is detected, and `agents/copy_editor.md` for the instruction that is not holding. Whether the fix is a stronger instruction or a mechanical restore of the missing `href`s is the interesting question; the PDF link-preservation work in the recent history is relevant prior art.",
      "truncated-lost": "Over the last \($tally.window_days) days, **\(.value | pct)% of \($tally.documents) documents** hit the model's output ceiling on a correction round and did not get the whole document back from the sectioned retry, so part of each of them kept the text it entered that round with.\n\nThe threshold is \(.threshold | pct)% of documents. The wider rate beside it — every document that hit the ceiling, whether or not the retry covered it — is `editor_truncated_rate` = \($tally.editor_truncated_rate | pct)%, and that one deliberately has no threshold: the copy editor is asked for the whole document, so its answer is as long as the document, and at a large `max_pages` a perfectly healthy document hits the ceiling every time. The gap between the two numbers is the sectioned retry doing its job.\n\nWhat a reader loses here is not source content — every character of the document is still in it — but the corrections for the part that came back uncorrected, and those issues had no editor pass at all: a truncation is the last round the loop runs, so nothing looks for them again. The delivered document says so under `@editor-truncated`, with `sections N of M` where some of it was rescued.\n\nThe remedy is usually the deployment rather than a prompt: `providers.<name>.max_tokens` too low for the documents this deployment accepts, or `max_pages` too high for that ceiling. `correctBySection` in `src/pipeline/review.ts` (with `MIN_SECTION_BUDGET` and `MAX_SECTIONS`) is where the retry decides what it can do, and an affected session's run log says which of those it was on an `editor_sections_declined` or `editor_section_failed` line.",
      # Parenthesised for the reason the lint-error value above gives.
      "unresolved": ("Over the last \($tally.window_days) days, **\(.value | pct)% of \($tally.documents) documents** finished the review loop with issues the loop could not resolve.\n\nThe threshold is \(.threshold | pct)% of documents.\n\nThese are barriers the Reader Agent found, reported, and that the loop then shipped anyway — listed in each session's `unresolved.md`. Some floor here is inherent, because a source document can be genuinely ambiguous, so what this issue actually asks is whether the current rate is that floor or a pattern. The paragraphs below are what answer it (#264), and each is absent on a deployment that does not record it — zeroes beside a non-zero rate read as a contradiction.\n\n"
        # Which exit ended each document, replacing the guess this body used to
        # offer ("worth checking whether max_review_iterations is too low").
        + (if ($tally.review_stopped // []) | length > 0 then
             ([$tally.review_stopped[].documents] | add) as $attributed
             # Printed as a fraction of the documents in the rate rather than asserted to equal
             # them, because on the week this ships they do NOT: the exit is written when a run
             # happens, so a 30-day window holds documents delivered before the field existed. The
             # live deployment's first report of it covered 7 of 77. A body that said "these sum to
             # 77" beside five counts adding to 7 would be read as a broken report, and — worse — a
             # reader who scaled the split up to the rate would be inventing 70 documents' exits.
             | "**Why the loop stopped:** "
               + ([$tally.review_stopped[] | "`\(.where)` \(.documents)"] | join(", "))
               + ". One per delivered document, so these describe \($attributed) of the \($tally.documents) documents above"
               + (if $attributed < $tally.documents then
                    " and NOT the window: the other \($tally.documents - $attributed) were delivered before this breakdown was recorded, so these counts — and the `cap`/`converged`/`truncated` split in the next paragraph, which is drawn from them — are out of \($attributed) and do not scale up to the rate. Those \($tally.documents - $attributed) are not a sixth kind of exit. Nothing after the split rescales either: `unresolved_severity` and `unfinished_page_rate` below are both over all \($tally.documents) documents, so subtract the floor from the rate as it stands and do not rescale it first"
                  else ", which is all of them" end)
               + ". `cap` is the only one raising `defaults.max_review_iterations` can help — read it beside `mean_rounds` = \($tally.mean_rounds), and check what the cap on this deployment actually IS before assuming the default of 3: a `cap` document spends exactly that many editor rounds, so on a window where every document named its exit the two numbers together bound it, and a deployment that sets 1 reports `cap` for a document that got a single round. `converged` is the editor having been shown the issues and answered \"no change\", which the loop treats as final ON PURPOSE (the next round is the same request about the same body), so its remedy is `agents/copy_editor.md` or `agents/reader.md` and never more rounds. `truncated` is the output ceiling, `unread` a review that could not read part of what it judged.\n\n"
               # The split the rate above cannot make, and the reason it was asked for (#264): a
               # threshold over the mixture is a threshold over two facts at once.
               + "**What the open list is a statement about:** on `cap` and `converged` it was read on the bytes that shipped — the loop re-reads at the top of every round and both of those exits are taken before the next editor call — so an open issue there is an open issue in the delivered document, and \(($tally.review_stopped | map(select(.where == "cap" or .where == "converged")) | map(.documents) | add // 0)) document(s) here are that. On `truncated` the list may be OLDER than the document: the reply was cut off, the sectioned retry may have corrected part of the body afterwards, and the round that would have re-read it is the one that could not be made (`src/pipeline/review.ts`) — so those \(($tally.review_stopped | map(select(.where == "truncated")) | map(.documents) | add // 0)) over-report on purpose, by an amount only the delivered document knows (`@editor-truncated sections N of M`). Read that part beside `editor_truncated_rate` = \($tally.editor_truncated_rate | pct)% and the output ceiling, and the first part as the share that is about the document. One threshold over both cannot be set honestly, which is why this one is still on the mixture.\n\n"
           else "" end)
        # Severity decides whether the rate above describes a defect at all: it
        # counts any open issue, and a Reader that reports nits has no ceiling.
        + (if ($tally.unresolved_severity // []) | length > 0 then
             "**How the Reader rated what was left:** "
             + ([$tally.unresolved_severity[] | "`\(.severity)` \(.documents)"] | join(", "))
             + " document(s). Per document and NOT a partition of the rate above — one document with a high issue and three low ones is in both — so these can sum to more than it does. `high` is the part a reader would call a barrier, and where a threshold belongs if the rate turns out to be the honest floor. `unrated` is the Reader having written something outside the three, not a fifth severity.\n\n"
           else "" end)
        # `if` on the number rather than on `> 0`: in jq only `false` and `null`
        # are falsy, so this prints an honest 0% and skips only a deployment that
        # does not record it. `> 0` would drop the most useful case — a floor
        # measured at zero, which says the rate above is entirely ours to fix.
        + (if $tally.unfinished_page_rate then
             "**The floor:** \($tally.unfinished_page_rate | pct)% of documents shipped with a `[page not fully transcribed]` marker still in the body, and those cannot finish clean at ANY budget: the Reader is told to report every one, and no pass here may resolve one — settling it means re-extracting that page. Subtract them before judging this rate against its threshold; their remedy is extraction and `max_pages`, not review.\n\n"
           else "" end)
        + "Only the **count** is available here, deliberately: an unresolved-issue description is model-written prose about one person's document, so it cannot leave the deployment (see `src/routes/quality.ts`). Reading the descriptions themselves means looking at recent sessions on the deployment."),
      "mean-rounds": "Over the last \($tally.window_days) days, documents needed **\(.value) editor passes on average** across \($tally.documents) documents.\n\nThe threshold is \(.threshold), against a default cap of 3 (`defaults.max_review_iterations`). A document the Reader passes on its first look costs 0 passes, so this number rising means more documents are coming out of assembly needing repair.\n\nThe average document using nearly the whole budget means extraction and assembly are producing work the review loop then has to undo. Every round is a full pass of two agents over the whole document, so this is a latency and cost number as much as a quality one. It is the weakest signal in this report and may simply mean the cap wants raising — the useful version of the question is *what the second and third rounds keep fixing*, which points at `agents/page.md` rather than at the loop."
    }[.key] // "No description available for finding key `\(.key)`."
  end) as $detail
| "**Measured:** `\(.metric)` = \(.value) (threshold \(.threshold))\n\n"
  + $detail
  + "\n\n---\n\n### How this was filed\n\n"
  + "Opened automatically by `.github/workflows/quality-report.yml` (PRD §7.16), which reads `GET /v1/quality` on \($url) once a week and compares a few rates against thresholds held in that workflow file. No model was involved in writing this issue — it is arithmetic on the numbers below.\n\n"
  + "**The threshold may be the thing that is wrong.** It is a guess, it lives in the workflow, and moving it is a one-line PR with a reviewer. If this rate is the honest cost of doing the job well, say so here and change the number — that is a better outcome than muting the workflow.\n\n"
  + "Everything above is aggregate by construction. The endpoint cannot return document text: the documents behind these numbers are user uploads, and this issue is public.\n\n"
  + "Closing this issue starts a \($cooldown)-day cooldown before the same threshold can be filed again, because the rate is measured over a \($tally.window_days)-day window and will barely have moved on the day a fix lands.\n\n"
  + "<details><summary>Full tally for this window</summary>\n\n```json\n"
  + ($tally | tojson)
  + "\n```\n\n</details>\n"
