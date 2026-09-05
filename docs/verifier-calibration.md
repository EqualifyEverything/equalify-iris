# Calibrating the fidelity verifier

Run this when you change `agents/feedback.md`'s VERIFY contract, change the model behind the
verifier, or want to know what the current pair catches before you trust a pass rate.

A **verdict** below is the Feedback Agent's decision about one page — `faithful` and `accessible`,
both as booleans, plus the problems it lists — and a **round** is a captured run of a corpus, called
a benchmark round or a deployed round depending on where it ran. The one exception is "wasted rounds"
below, which means correction passes spent on a page rather than runs.
[README § Terms](../README.md#terms) defines both, and `fragment` and `declaration` with them.

Every accuracy claim this pipeline makes rests on one call: the Feedback Agent's VERIFY task,
which compares a page's HTML against the page image and says whether it is faithful. That
verdict rejects roughly four pages in five — 58 of 75 across three 25-page runs (issue #137, cited
in `correction.ts`), then 76 of 100 and 74 of 94 in two benchmark rounds (issue #182, cited in
`test/verify-kinds.test.ts`) — and two explanations fit that
number equally well: the extraction really does need correcting on most pages, or the verifier is
calibrated to find something and finds something. The verdict cannot answer that about itself.

`src/tools/calibrate.ts` asks from outside. It takes pages the verifier already passed, damages
exactly one thing in a copy of each (`src/pipeline/calibration.ts` — a dropped table row, a whole
table dropped, a changed number in a cell, a removed heading, a demoted heading, missing alt text,
two paragraphs swapped, a truncated tail), and puts both copies back to the same verifier against the same
image. Out come two rates that have to be read together: how often it **passes the clean copy**
(its false-positive rate) and how often it **catches the injected defect and names the right
kind**, per defect type. A judge that rejects everything scores a perfect true-positive rate and
is useless, which is why neither number is reported without the other.

```bash
# free: selects the pages, applies every defect, prices the live run in calls
node --use-system-ca --env-file-if-exists=.env src/tools/calibrate.ts \
  --session ses_01K... --session ses_01K...

# the measurement itself: one verify call per clean page + one per damaged copy
node --use-system-ca --env-file-if-exists=.env src/tools/calibrate.ts \
  --session ses_01K... --defects all --out calibration.txt --run
```

Without `--run` it makes no model calls at all, because the live run is the part that spends
money. `--session` takes a session id or a path (a worktree can read the main checkout's
sessions), and `--help` lists the rest. Pages are selected from `page_verify_ok` in each
session's log, so a rejection of the clean copy really is a contradiction of an earlier verdict
rather than a disagreement with a different judge; `--all-pages` drops that and measures against
pages the verifier may well have been right to fail. A page whose verdict *described* a defect while
passing it (`page_verify_inconsistent`, below) is not a clean copy either and comes out with the
unjudged ones — the verifier has already said in prose that the page is wrong, so a rejection of it
would be that verdict repeated rather than a false positive. Only logs written since that event
existed can say, so this changes nothing about the corpus below: the dry run over the same five
sessions still selects the same 11 pages and 30 damaged copies.

Two things the report says out loud, because the counts alone would read as results: calls where
nothing was judged (no Feedback Agent, an unparseable reply — `verifyAgentOutput` answers ok=true
in those cases so verification can never cost a page — or a call that threw, which is listed with
its error) are excluded from every rate, and defects that were never applied are named rather than
left looking like zeroes.

Each page is judged against the contract **it was written to**, recovered from git by the blob SHA
its session's log recorded. The verifier is not rolled back — today's judge is the subject — but
the contract must be, or a page rejected for breaking a rule added since it was extracted is
counted as a false positive. That is not hypothetical: on the first run of this harness it was the
difference between a 55% false-positive rate and a 0% one.

**First measurement** (2026-08-26, 11 pages across 3 documents, every applicable defect, 41 calls,
`sonnet-4-6`):

| | rate |
|---|---|
| clean copies passed | 11 of 11 — **0% false positives** |
| damaged copies flagged | 25 of 30 — **83%**, all 25 tagged with a predicted kind |
| damaged copies the verifier *saw* | 28 of 30 — **93%** (see below) |
| dropped row / dropped table / changed number / dropped heading / removed alt / truncated tail | 100% each |
| heading demoted two levels | 4 of 7 flagged — **57%** |
| two paragraphs swapped | 3 of 5 flagged — **60%** |

So the ~80% rejection rate looks honest rather than reflexive: this verifier does not fail pages it
has nothing to say about, and it flags every defect that removes or falsifies content.

The gap is narrower and stranger than a blind spot. Of the five defects it did not flag, **three it
described in full and then answered `faithful: true` anyway** — one quoting both paragraphs of a
pair it had just found reversed. `failedCheck` requires `ok === false` *and* a non-empty problem
list before the pipeline will correct a page, so those pages ship with the defect written down in
the log and nothing done about it. That is a fixable contract problem, not a perception problem, and
it is why the report scores "said but did not flag" in its own column instead of counting it as a
miss: the two failures point at different repairs.

Every run now records that case as it happens: a verdict that names a problem while passing the page
writes `page_verify_inconsistent`, and the diagnostics summary counts those pages in
`verification.verify_inconsistent`, split by the kind of problem named. Nothing acts on it — the
repair worth having is to fail a page whose verdict names missing, wrong or misshapen *content*
whatever its flags say, and that is a page call per such page, which wants a fleet's worth of
counting before it changes what a document costs. Failing on any named problem instead would buy one
for every `alt_quality` suggestion the same agent is asked to volunteer.

Small corpus — 11 pages over 3 documents, and two of the defects were exercised on a single page
each — so treat the per-defect rates as directional. Both runs of it produced identical totals, and
the dry run over the same five sessions still reports the same 11 pages and 30 damaged copies after
the injector guards were tightened, so these numbers are the current code's.

The verdict's other contract problem runs the opposite way, and the two are a matched pair: not a page
that passes on a defect it described, but a page that fails on a problem it has already withdrawn.
`problems` is handed to the correction pass verbatim under "resolve every problem", and since issue
#132 it is also the only thing that pass may change — so an entry reasoning its way to "on closer
inspection this is correct, disregard" is both work to do and permission to alter text the verifier
had just confirmed was right. Over 45 undamaged control pages read three times each, the deployed
verifier retracted **32 of its 244 problems inside their own strings**, on 7 pages of 45, and 14 of
its 71 rejections carried at least one of them to the corrector (issue #339). **Every model does it**,
and how often depends on the corpus rather than the vendor: on those undamaged control pages a candidate
at another vendor did it 0 times in 273 problems, but on a real 100-page document the three models
measured 2.7%, 3.1% and 4.5% — a factor of 1.7, not an infinity, and 4.5% is the figure a production run
sees. An earlier revision of this section quoted the control-page 0 as evidence that the behaviour is not
inherent to the task; it is not that, and the same round found that 13.1% itself did not reproduce on a
10-page subset of the very same pages (0.0%), so the control rate is a noisy measurement of a real
defect rather than a vendor difference. No page in that round was rejected *solely* on retracted items —
though one page in a later verify-only round was, so that bound is low rather than zero — so the cost is
mixed instructions rather than wasted rounds, which is the expensive kind here, because the page agent
does as it is told, including replacing words that were already right.

The cause is the reply shape rather than the model: `{ faithful, accessible, problems }` left nowhere
to think, so the thinking went to the only free-text field there was, and that field is the one that
drives the corrector. `agents/feedback.md` now defines `problem` as the conclusion only, says an item
concluded **not** to be a problem is omitted rather than narrated, and gives the working-out a
destination — `notes`, read by nothing: not `readProblems`, not the correction prompt, not the
delivered document. Naming a destination rather than only forbidding the narration is issue #303's
lesson read the other way round, since what the Reader stopped writing as prose partly came back as
issues asking for no change. That every model does it on real pages is the strongest form of the
schema argument — one of the specimens declares the entry "excluded from problems count" from inside
the problems array, which is the case for a destination made by the model itself. It also means the
**instruction** half has no proof of sufficiency: no model has been shown going to zero by instruction
alone, so the omit-rather-than-narrate sentence is shipped as cheap and plausible, not as demonstrated.
`test/verify-notes-field.test.ts` pins both halves — the clause, and the
promise the clause makes to the model about where `notes` goes, which is the half a later change could
quietly falsify. What it costs is 1,253 characters of prompt on every verify call; what it buys is
**not** measured — the behaviour was counted and the fix was not — and `pages_unjudged` is the number
to read beside any re-count, because an invited free-text field makes a reply longer and a verify
reply that stops mid-object is a page nothing judged, shipping under a `page_verify_ok` line.

Inviting prose also invites a reply that quotes the contract back, and `extractJson` returns the LAST
readable object in a reply. So an unescaped `{ "faithful": true, "problems": [] }` inside `notes` ends
the reply with a second object that carries the decision flag, and reading it turns a page the
verifier rejected for a missing table row into a confident pass — no problems, no `unjudged` marker,
a plain `page_verify_ok` line, the one shape `pages_unjudged` cannot count. Two things close it. A
reply that is nothing but its object is now read with the repair rule's colon case confined to keys,
which is where JSON puts a colon after a string — and that reading is taken only where the ordinary walk
did **not** already close on the reply's last character, and where the reading's own strings are
self-contained, every `{` inside them closing inside the same string. Every limit there is measured.
Applied to every candidate in the walk the narrow rule changes 14 of 4,100 bench replies and loses on
all 14: a Reader verdict quoting `{"html":"…` in its prose gets a string that never closes and swallows
the verdict, returning one issue instead of five. Its own weak case is a draft abandoned mid-string and
restarted inline, where it returns the abandoned prose glued to the front of the page. Two gates refuse
that, and it took both: a restart the walk can read **whole** closes where the reply closes, so nothing
is left for a second reading to recover; and the abandoned `{` does not close inside its string, which
catches a restart the walk could only read in part. The brace test alone is not enough, because one `}` in the restarted page
content — a code listing, template syntax, a math brace — rebalances the abandoned string.
Discarding the reading costs nothing: it answers with the walk's result, which is the answer before any
of this. And because a fenced reply is beyond any one-pass reader,
`verifyAgentOutput` now refuses to read anything carrying fewer than both boolean flags as a verdict:
1,342 of 1,342 readable verify replies in those logs carry both, so the check costs nothing measurable
and converts a silent pass into a counted `unjudged` page. What it does cost is the opposite shape — a
`faithful: false` reply that omits `accessible` no longer buys a correction — and that page is counted
rather than corrected, which is the trade made knowingly.

A whole class of decoy defeats both, and it is named here at its real width because it is the class the
new field most invites: **a quoted decoy containing any string value at all**. Every reading here treats
a `"` after a `:` as an opener and a `"` before `,`, `}` or `]` as a terminator, so the real `notes` value
ends inside the quoted sentence, no whole-reply object is available to prefer, and the quoted contract —
carrying both flags as booleans — is what the flags gate sees. It reads as a pass on a rejected page, on
`main` and after this change alike. What the parser change fixes is only the decoy with **no** string
values, which is the shape the issue produced; an earlier revision of this section called the residual
"one shape … a decoy quoting an **empty** string", which had the mechanism right and the width wrong in
the expensive direction, since the empty string is the minimal instance rather than the trigger. What
removes the class is the prompt clause asking for no quoted JSON in `notes` at all, which is why that
clause is not treated as decoration. Both an empty and a non-empty instance are pinned as
failing-by-design assertions in `test/envelope-as-content.test.ts`.

**A rejection can be wrong in a way no gate downstream can see, and the reason it gives decides the
repair.** On the nine legend-bearing figure pages of a 100-page document the extraction read the
shading key correctly and the verify-and-correct pair — 63.7%–76.0% of what those pages cost —
removed it: two of three verify calls read a `<dd>` describing a swatch as the invented expansion
`agents/page.md`'s abbreviation rule forbids, and the compliant correction deleted it, so the only
three serious accessibility violations in that arm's whole output were created by the repair rather
than found by it (issue #347). On one page the verifier also overturned the extraction's own hedge —
*"none visibly distinct from medium in this reproduction"*, which measurement off the source image
confirms is correct, the two light bands being 33 luminance units apart under a 113-unit vignette —
and named thirteen states as the lightest shade of which seven carry the darkest fill, at 48.6% of
that page's cost. `agents/feedback.md` now names the case: a description of ink standing as a
legend's term is the transcription the contract asks for, a swatch's tone is read off the swatch and
not off the order of the labels, and a stated uncertainty is checked against the image before it is
contradicted. It also says that a problem's **reason** is part of the licence `correctPage` acts on
and not commentary on it — the same page's third problem called the legend's printed two-line
heading "invented text not present as a legend label" and the correction deleted it, where "a
heading glued to the first label" would have licensed moving those words. Nothing else could catch
any of this: the corrected page is well-formed, specific and false, and every automated gate passes
it. Pinned in `test/feedback-prompt.test.ts`; the page-agent half, and the cover-page clause
ordering that came with it, are in issues #347 and #351 and in
`test/page-prompt.test.ts`.

Two of that verifier's cheapest checks need no image at all, and issue #353 is where both were
missed on one page. The fragment's `<figcaption>` transcribed the figure's printed subtitle — *"Eight
of the Twelve States That Shift…"* — and its `alt` attribute, ten lines above, enumerated 40 states
as above-average; the verify pass quoted the legend's labels verbatim in its own first problem, and
then asserted one more state into the category, so the delivered page names 41. Measuring the sheet
puts the true partition at 8 and 4 with everything else base map, matching the printed arithmetic
exactly — and the legend's own swatch cannot settle it, reading 100 against fills of 32–42 and
163–186 under a 55-unit lighting gradient, so on this page the caption was the only sound decoder.
Both prompts now compare an enumeration against a count the page states before grading anything that
turns on the ink, and `agents/feedback.md` bounds the repair at that count: a list may be sent back to
be **shortened**, and never taken past the number the page prints. Not "never lengthened" — a list
naming nine where the page prints twelve is three members missing, which is a real `content_missing`
finding, so that direction stays reportable with the printed number quoted as its bound, and a
verifier that cannot say which members are missing says the list is short rather than naming three.
The second check is a signal the pipeline already emitted and nothing consumed: the page agent's
`suggested_agent` request, which in one 100-page round fired 7 times on 5 pages under 6 names, every
one a map specialist, none resolvable — and those 5 held 4 of the 5 pages whose ink reading has since
been graded wrong. An unmet request is now carried into the verify message (`specialistCaution` in
`src/pipeline/extraction.ts`, after the cached prefix so one page's note cannot cost the document its
cache reads), where it narrows what the verifier may assert: it can ask for an unsupported reading to
be hedged or removed, and may not supply one of its own. **Unmet** is not the same question as
dispatched, and they disagree on four of the six ways a request can end. Three of those four were
silent: a specialist that ran and found nothing of its type, one that threw, and one whose fragment
would not merge all report *dispatched* and all three leave the page agent's own unaided HTML in front
of the verifier. The fourth was the costly one, because it answered wrongly rather than not at all — a
*standard* type such as a table reports not-dispatched, and was told the name had not resolved, when in
fact it is declined by a policy that makes the general pass its intended handler rather than a
fallback; it now carries no caution. So the dispatch returns the phrase, and the caution says which of
the four it was. It is not treated as a detector — it is
page-level rather than per-arm and it missed two hard pages in that round — so that licence bound
holds on every page and the flag only says where the model has already admitted the difficulty.
Issue #353, with the carrying pinned in `test/verify-specialist-caution.test.ts`.

The third check is the same comparison on the other axis, and it is the one that fires on the page
above (issue #355). Its `<figcaption>` also read *"The South, in General, Has the Lowest Effective
Rates; the New England and Mideastern States, the Highest"*, and the `alt` filed **0 of 6** New England
and **0 of 6** Mideast jurisdictions in its highest band — eleven of the twelve in the *second-lowest*
— while the South passed as a control at 6 of 6 in the lightest. Where the count check compares a
list's length against a printed number, this compares its membership against a printed region, and
both prompts now make it before anything that turns on the ink. Three properties of that sentence
shape the rule. It is a generalisation — *"in General"* is the page's own hedge — so what it can
contradict is the whole set and never one member. It says which region runs high and never which place
sits in which band, so it licenses no reassignment: the reader re-reads the ink, and the verifier may
ask for the sorting to be hedged, scoped or re-read and may not supply the assignment itself. And
which places a region covers is world knowledge rather than text on the page, so both prompts refuse
the comparison where that membership is not certain, because supplying it manufactures the
disagreement it would then report. The ink agrees with that refusal to referee: New York's fill is
darker than Pennsylvania's by about a category step while the `alt` files both in the same band, and
the absolute category of either is unavailable — the paper under the legend reads ~72 against ~90–98
at the states, a baseline shift larger than the 13-unit gap between the categories being decided.

That page also paid **$0.04529, 67.4% of its own cost**, for one edit: Missouri moved from `darkest`
into `cross-hatched`, which the plate's texture puts on the flat side of the legend's own gap (sd 9.1,
against 17.2 for the hatched swatch, at most 7.1 for the three flat ones, and 25.7 for Wisconsin at
the identical median). The log line for that correction said `alt_changed: true` and nothing else, so
`correctionEffect` now also names **which members a correction moved from one list into a disjoint
one** (`alt_relocated` on `page_corrected`). It passes no judgement on which of the two replies is
right — on that plate the two dark categories are 13 units apart under a 112-unit lighting vignette,
so nothing can — and it is not a gate: what ships is unchanged. The members are named rather than
counted, because a boolean saying something moved somewhere is not a claim anyone can check. Two
conditions keep it quiet: the two lists must share no member, and the list joined must be one that
already existed in the description being corrected, by two or more names already listed together — a
member whose new neighbours are all new text is a sentence someone rewrote around it. A list starts at
two names, a floor pinned in both directions: three at each end failed no test, since the destination
condition already refuses the two-phrase false positive it was aimed at, and it declined the real shape
at its smallest. Issue #355, with both
halves pinned in `test/page-prompt.test.ts`, `test/feedback-prompt.test.ts` and
`test/verification.test.ts`.

The fourth check is not a comparison at all but a field the verifier was never shown: the page
agent's own `"log"`. `agents/page.md` asks for it by name in **26** places, and for six kinds of
finding it asks for a log entry — a page ending mid-sentence, a heading with no parent on the page,
a symbol with no key, a placeholder image source, a language change, an irregular table. The verifier
judges the HTML against that contract and was given the HTML alone, so on all six it could only ignore
the rule or hunt for its evidence in the markup, where for two of them the contract does not put it. Across **311
verify replies, 35 problems on 26 replies demanded something of the log, and 26 of the 35 were about a
log that existed and was not shown** (issue #349). It is now quoted in the verify message, after the
cached prefix like the caution and clipped at a bound no observed log reaches (median 671 characters,
longest 2,566 over 2,001 replies). What the prompt may do with it is deliberately small: the log is the
transcriber's account of its own work, so a **record** the contract asks for in the log and nowhere
else is made there and reporting it as unrecorded is a false finding, while a log the image refutes
makes the missing content the problem with the agent's own words as the reason. Only two of the six are
log-only, and the distinction is the whole clause: the other four oblige the HTML as well — the
`[page not fully transcribed]` marker, a placeholder `src`, `lang` on the element that changes language,
a note on an irregular sequence — so the prompt says that half is still the verifier's and hands the log
back as **evidence for** reading it. A log admitting the page was cut is the reason to look for the
marker, not a discharge of it; the looser wording would have shipped a truncated page without one. The
four do not share one `kind`, and the prompt names all four rather than leaving them to a tiebreak that
only reaches problems where content is absent: an absent marker or irregularity note is
`content_missing`, a named language with no `lang` is `a11y_only`, and a graphic with no placeholder
`src` is `structure_wrong` — the placeholder is for whatever supplies the real asset, so what is
incomplete there is the markup and not a reader's access to the graphic. The log is never the subject of a problem — the
correction pass is parsed for `html` alone and writes no log, so "the log does not note X" is an
instruction nobody can carry out and it spends the page's only licence. Both rechecks of a correction
are sent none, because the log they would carry describes a fragment that has since been rewritten.

That field is also missing outright on **13.7%** of pages, and nothing said so. When a reply arrives as
markup rather than as the envelope, `bareHtml` rescues the page from the text as it stands — a usable
page with no `"log"`, no `suggested_agent` and no blank declaration — and it shipped as an ordinary
success: 41 of 300 first page calls in two multi-vendor rounds, 54 of 400 across four deployed rounds
of one PDF, and 0 of those 41 left any other line behind. `page_bare_html` now says it and
`pages_bare_html` carries it in diagnostics beside `pages_failed` and `pages_blank`, named for the
reply's shape rather than the consequence because an enveloped reply that merely leaves the field empty
has a different remedy — and is 0 of 2,320 page replies across 67 round logs, so today the line
accounts for every page with no log. In the same change `agent_sha` stops being null on every deployed
round: it was `git rev-parse HEAD:./<file>`, which needs a `.git` the deployment container does not
ship, and it is now computed from the prompt text, which is the same number `git hash-object` gives.
Four deployed rounds of one PDF moved a defect from 0 pages to 28 of 100 with no log among them able to
say which prompt each ran. Issue #349, pinned in `test/page-log-to-verifier.test.ts`,
`test/feedback-prompt.test.ts`, `test/agent-sha.test.ts` and `test/page-failure.test.ts`.
