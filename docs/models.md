# Equalify Iris — which model runs which agent

Iris dispatches five agents plus any specialist a page names, and a deployment can point each
one at a different provider and model with one line of `providers.per_agent` (PRD §10.3,
`config.example.yaml`). This document is the answer to "which line should I write, and what does
it cost" — the outcome of the model-selection sprint tracked in
[#246](https://github.com/EqualifyEverything/equalify-iris/issues/246) and reported in
[#311](https://github.com/EqualifyEverything/equalify-iris/issues/311).

Two of the five agents have a cheaper model that measured no worse. Two were left alone for a
measured reason worth reading before benchmarking them again, and one has never been measured at
all — for a reason that is also worth knowing (§4).

**Every figure here names the benchmark round it came from**, because some of them are stale by
design and one is superseded outright — §6 says which. The reference deployment and
`config.example.yaml` both serve every capability with `us.anthropic.claude-sonnet-4-6`, and
"the incumbent" below means whatever that config resolves to, not that model by name.

## 0. The short version

| agent | share of the model bill | recommendation |
|---|---|---|
| `page` | **44.5%** | **swap to `moonshotai.kimi-k2.5`** — no measured quality loss, −56% of this agent's spend |
| `copy_editor` | 25.0% | keep. The wins here were code, not a model |
| `feedback` | 18.0% | keep. It is the oracle every other number is scored against |
| `reader` | 12.6% | **swap to `moonshotai.kimi-k2.5`** — 78% of the incumbent's own agreement floor at −77% |
| `builder` | 0% | not measured. Its zero and the specialist's are the same zero (§4) |
| specialists | 0% | no change, and no round: 0 calls on a corpus with no charts in it |

Shares are of $17.86 for 100 pages, `runs-bystep-100` at `158e3d9` — a partition of that round's
priced spend, adding to 100%. They are **shares, not prices**; see §6 before quoting a dollar
figure forward.

Both recommendations are one line each:

```yaml
providers:
  per_agent:
    page: { provider: bedrock, model: moonshotai.kimi-k2.5 }
    reader: { provider: bedrock, model: moonshotai.kimi-k2.5 }
```

## 1. The knob, and the way it fails

`resolveAgentModel` (`src/providers/index.ts`) resolves a model from **agent name and capability
only**. The `{ step }` on a `router.complete` call is telemetry — it feeds `by_step` in
diagnostics — and routes nothing. So the swappable unit is the agent, and there are five the code
dispatches:

| agent | dispatched from | job |
|---|---|---|
| `page` | `src/pipeline/extraction.ts` | the page → HTML pass, and the correction of a page that failed verify |
| `reader` | `src/pipeline/review.ts` | reads the assembled document and reports issues |
| `copy_editor` | `src/pipeline/review.ts`, `src/pipeline/tables.ts` | applies the review, and merges a table split across a page break |
| `feedback` | `src/pipeline/feedback.ts` | VERIFY / CLASSIFY / TRAIN — the judge |
| `builder` | `src/pipeline/contribute.ts` | drafts a specialist agent file for a content type a page asked for |

plus any specialist named by a page suggestion, whose key is the file stem in `agents_dir`
(`chartDataAgent` is the only one shipped). `copy_editor` is **one line for two jobs**, so the
review round and the table merge cannot be put on different models.

**A key naming anything else is ignored, and nothing in the run says so.** The call finds no
override and falls through to the provider's own `per_capability`/`default_model`; the run
succeeds at the price it would have cost anyway, and `by_agent` reports the agents that *ran*, so
it cannot tell a model that was never swapped from one that was. This matters most to exactly the
reader of this document: **a typo in a swap reads as "the cheaper model did not save anything."**
Boot warns about a key it cannot route (`perAgentKeyWarning`, `src/config.ts`) — check the log
line once after editing, and note that it warns rather than refuses, because a specialist's name
is a file on disk and the valid set is therefore open.

## 2. `page` — the largest line on the bill

`runs-extract-ad3e7a6`: 7 models × 11 deliberately hard pages, Iris at `ad3e7a6` with a clean
tree, `agents/page.md` at `635267ac32bb`, `agents/feedback.md` at `b4b2d3cac40f`, judge pinned to
the incumbent on **every** arm, all rows `ok` and `priced`, 0 unattributed calls.

Pinning the judge is what makes the table a costing of a real swap: `feedback` is a separate
config line, so a `page`-only swap keeps paying incumbent rates for verification. The two columns
are therefore split.

| model | page agent $/pg | vs incumbent | judge $/pg | total $/pg | word recall | first-pass | pages flagged |
|---|---|---|---|---|---|---|---|
| `claude-sonnet-4-6` (incumbent) | $0.0611 | — | $0.0231 | $0.0842 | **98.71%** | **1/11** | 29 |
| **`kimi-k2.5`** | **$0.0268** | **−56%** | $0.0222 | **$0.0489** | **98.74%** | **1/11** | **25** |
| `qwen3-vl-235b-a22b` | $0.0237 | −61% | $0.0244 | $0.0480 | 96.59% | 0/11 | 31 |
| `claude-haiku-4-5` | $0.0217 | −64% | $0.0229 | $0.0446 | 96.64% | 0/11 | 34 |
| `gpt-5.6-luna` | $0.0183 | −70% | $0.0205 | $0.0389 | 98.63% | 0/11 | 28 |
| `nova-2-lite` | $0.0077 | −87% | $0.0194 | $0.0271 | 97.97% | 0/11 | 30 |
| `gemma-3-27b-it` | $0.0073 | −88% | $0.0258 | $0.0331 | 86.53% | 0/11 | 41 |

`pixtral-large-2502` is in the roster and produced **no row at all** — it was unreachable. That is
a gap in the benchmark, not a result about the model.

"Pages flagged" is the last column to read alone: it is the **sum of the judge's four defect kinds
over 11 pages**, and a page can be flagged under more than one, so it is not a count of kinds and
not a count of pages. Broken out, it is the column that separates the cheap arms:

| model | content_missing | content_wrong | structure_wrong | a11y_only |
|---|---|---|---|---|
| `kimi-k2.5` | **5** | **4** | 9 | **7** |
| `claude-sonnet-4-6` | 6 | 8 | **7** | 8 |
| `gpt-5.6-luna` | **5** | **4** | 9 | 10 |
| `qwen3-vl-235b-a22b` | 7 | 6 | 9 | 9 |
| `claude-haiku-4-5` | 9 | 8 | 9 | 8 |
| `nova-2-lite` | 10 | 3 | 8 | 9 |
| `gemma-3-27b-it` | 10 | 9 | 11 | 11 |

**Why Kimi and not the two arms that are cheaper still.** Word recall cannot see *which* words.
`nova-2-lite` reads 97.97% of them and still loses content the judge can see on **10 of 11
pages**. `gpt-5.6-luna` ties Kimi on both content kinds and is 30% cheaper, and it is declined on
one column: the incumbent judge flags its **accessibility** output on 10 of 11 pages against
Kimi's 7 and the incumbent's own 8 — the worst of any arm but gemma. On an accessibility product
the cheapest arm that gets the prose right is not the cheapest arm that does the job.

Kimi is the only non-incumbent arm that is at-or-better than the incumbent on every axis measured
at once: recall, first-pass rate, and three of the judge's four kinds.

**What this does not establish.** Recall is over 9 scored pages — the two `acir-scan` pages are
pure scans carrying `truth_words: 0` by design, and every arm produced a judge-rejected page on
both. A 25-vs-29 difference in flags across 11 pages is not statistically separable and is not
claimed to be; the claim is that Kimi is not *worse* at 56% less. And the judge is the incumbent
model grading a rival — worth naming, though it raised 29 flags against its own output and 25
against Kimi's, so it is not sparing itself.

## 3. `reader` — the cheapest defensible cut

`runs-reader-newsha` and `runs-reader-newsha2`: 20 stitched documents × 2 passes × 4 models =
**160 document-runs, $6.64**, both rounds at `e842faa` with a clean tree, 0 model mismatches, 0
unpriced rows. `e842faa` is code-identical to the page round's `ad3e7a6`.

The metric is agreement with a reference issue set, as a percentage of **the incumbent's own
single-pass self-agreement floor**: the incumbent reproduces 152 of 180 reference issues on a
second pass, so 84.4% is 100% here. Nothing can be asked to beat a model's own repeatability.

| approach | % of floor | $/doc |
|---|---|---|
| incumbent ×1 — the floor, 152/180 raw | 100% | $0.0938 / $0.0924 |
| **kimi ×2** | **89%** | $0.0415 |
| haiku ×2 | 80% | $0.0717 |
| **kimi ×1** | **78%** | **$0.0216** |
| luna ×2 | 74% | $0.0329 |
| haiku ×1 | 66% | $0.0359 |
| luna ×1 | 61% | $0.0195 |

The incumbent's own $/doc is given twice because the two passes cost $0.0938 and $0.0924 for
identical work — the floor's price is repeatable to about 1.5%, which is the resolution of every
comparison in the column. A `×2` row is not a run: it is the union of two independent single-pass
runs, priced as the sum of both.

**Ship `kimi ×1`: 78% of the floor at $0.0216/doc, −77%.** It is a config line and nothing else.
**The two-pass form is not a config change.** It reaches 89% for $0.0415 (−55%) and is worth
having, but Iris would have to sample each window twice *and* dedupe by anchor;
`dedupeNoContentIssues` (`src/pipeline/review.ts`) does not do that — it is scoped to no-content
reports. Applied without that step, the second pass sends the editor duplicate findings and the
89% does not hold.

**Kimi ×2 beats haiku ×2 on both axes at once** — more agreement for less money — so haiku is not
on the frontier for this agent at either pass count.

The ordering survives a change of reference, which is the only reason to trust it: scored against
the *other* pass's issue set instead (floor 148/170 = 87.1%), the four Kimi and luna arms come out
84% / 72% / 70% / 57% — different numbers, same order. That check covers Kimi and luna only;
haiku's rows are absent from that second artifact as it now stands, though its two passes are both
in the round's records and priced.

## 4. The three keeps

**`copy_editor` (25.0%) — keep.** Every win on this agent this sprint came from changing what it
is asked to do, not who does it: table joins moved into code
([#278](https://github.com/EqualifyEverything/equalify-iris/issues/278) — 62% of split tables
joined at $0, 0 refused by Iris's own `verifyJoin`, with the measured caveat that the code path
keeps the first half's header and one joined document read "19592"); the editor patches blocks
instead of retyping the document (#277, #258 — 22%, after the finding that 44% of documents could
not fit the reply at all); and a truncated reply's completed blocks are now applied instead of
thrown away (#300). No cheaper editor has been benched as *better*, and this agent's share is
larger than the sprint's own report had it, so it is the obvious next place to look — see §8.

**`feedback` (18.0%) — keep, and treat a swap here as a change to the instrument.** This is the
judge behind every quality number in this document, in `/v1/quality`, and in Iris's own review
loop. Its rejections are mostly real: of 33 rejections of *undamaged* control documents, 26 were
genuine contract violations, two of which have since been fixed in Iris. A cheaper judge does not
just cost less — it moves every measurement, including the ones used to justify the two swaps
above.

**`builder` (0%) and specialists (0%) — no round, and one zero, not two.** `runContribution` is
called with the page pass's `suggested_agent` list (`src/pipeline/orchestrator.ts`), and the
`builder` call is made per suggestion inside it, after a suggestion naming a content type the page
pass already covers has been declined. So on a corpus where no page names a specialist, both rows
read 0 from a **single** cause. The 100-page round is one US appropriations report — text, tables,
footnotes, **no charts** — which is exactly the corpus on which that gate never opens. Neither
zero is evidence about a model.

## 5. What the two swaps do to the bill

Applying the measured per-agent reductions to `runs-bystep-100`'s shares:

| | $/page | vs $0.1786 |
|---|---|---|
| measured, no change | $0.1786 | — |
| `page` swap only | $0.1341 | −25% |
| `page` + `reader ×1` (both config lines) | **$0.1168** | **−35%** |
| `page` + `reader ×2` (needs the dedupe change) | $0.1218 | −32% |

This is an **extrapolation, not a measurement**: the −56% and −77% were measured on 11 hard pages
and 20 stitched documents respectively, and are being applied to a 100-page report's shares. It
also credits none of the code wins merged since that round (§6). The honest summary is "about a
third of the model bill, all of it from two config lines" — the `page` swap is roughly
three-quarters of that third on its own.

#246 set the target at ~$0.02/page. A third off $0.1786 is still **roughly 6x** that. The
remaining gap is not a model-selection problem, which is the most useful thing this sprint
established.

## 6. Where every figure comes from, and which are stale

| figure | round | Iris at | still good? |
|---|---|---|---|
| page $/pg, recall, flags | `runs-extract-ad3e7a6` | `ad3e7a6`, recorded in the round | **yes** — everything merged since is docs or the config warning |
| reader % of floor, $/doc | `runs-reader-newsha`, `-newsha2` | `e842faa`, recorded, code-identical to `ad3e7a6` | **yes** |
| cost shares (44.5 / 25.0 / 18.0 / 12.6) | `runs-bystep-100` | `158e3d9` (derived, below) | **as shares only** |
| $0.1786/page, $17.86/100 pages | `runs-bystep-100` | `158e3d9` | **stale as a price** — quote it only with the sha attached |
| "10.89% of spend bought nothing" | 63 rounds, mixed | pre-#300 | **no. Superseded — do not quote it forward** |
| specialists = 0 calls | `runs-bystep-100` | `158e3d9` | yes, **on a corpus with no charts** |

The shares predate nine merged changes: #297, #298, #300, #302, #303, #304, #306, #309, #310.
Two of those move the shares in a known direction — #303 cut reader $/doc by about 13%, and #298
stopped sending pages already accepted as blank to the judge — so `reader`'s true share is now
*below* 12.6% and `feedback`'s below 18.0%, which makes `page` a *larger* fraction than 44.5% and
both swaps slightly better than the table says. That is the direction of the drift, not a
measurement of it.

**The 10.89% figure is the one thing in the sprint report that must not travel.** As reported
there it was $19.2282 of $176.5280 across 63 captured rounds — spend on replies that were thrown
away, $17.23 of it `copy_editor` — and #300 was filed *on that number* and now applies the
completed blocks of a truncated reply. The ceiling it measured no longer buys nothing.
Re-deriving it is the first item in §8.

**On the sha for the cost shares.** The round records no `iris_sha` of its own — a gap on the
benchmark's side, since every model-driven round records one — and the sprint report inferred
`158e3d9` from a file timestamp. It is derivable instead, from two records that do not depend on a
mutable file: the round's `ledger.jsonl` puts its four chunks between 07:38:58Z and 08:03:42Z on
2026-09-01 (longest round trip 23 minutes, so the first submission was no earlier than about
07:33Z), and the deploy notifications for main put `158e3d9` live at 05:42:34Z and its successor
`e173d1c` at 09:05:05Z. The whole round therefore ran on `158e3d9`. Worth writing down because the
timestamp route is now unavailable: re-running the benchmark's `report.mjs` over that directory
rewrites `summary.json` and `results.jsonl`, and doing so on 2026-09-01 reset both mtimes.

**Two numbers in [#311](https://github.com/EqualifyEverything/equalify-iris/issues/311) are not
the ones in §0**, and both are in the recommendations' favour. That report gives `page` 43.2% and
`copy_editor` 20.8%; `runs-bystep-100/summary.json` gives **44.5%** and **25.0%**, and its four
agents partition the round's spend exactly (100.0%), where the report's four sum to 94.6%. 43.2%
is `runs-177`'s `page` share — an earlier round, 2026-08-25, $17.83 — and 20.8% does not match any
captured round's `by_agent`. The figures published here are the ones that re-derive from the
round's own summary.

Everything else in this document was re-derived from the round records before it was published
here: the page table in full (every price, recall, first-pass rate and defect count), the reader
column at its stated reference, both rounds' shas and totals, and the $/doc of every arm including
the two-pass sums. Two things in the sprint report were not re-derived and are marked where they
appear — the reader's second reference column, and the sprint-wide spend totals behind the 10.89%.

## 7. Four limits worth knowing before re-benchmarking

- **There is a ceiling and it is about 84%.** The incumbent reader agrees with its own previous
  pass on 84–85% of issues. Every "% of floor" number is against that, not against truth. A raw
  agreement figure quoted without the floor beside it overstates the gap between models.
- **Every share needs its denominator.** 44.5% is of $17.86 at `158e3d9`. −56% is of the page
  agent's own spend, not of the bill. 89% is of an 84% floor. 10.89% was of $176.53 across 63
  rounds. Those are four different denominators, and mixing them was the most common way a number
  went wrong in this sprint.
- **The oracle is a lower bound, and it is the incumbent.** A flag on a page a human would pass is
  a cost, not an error; the judge was never scored against itself.
- **The corpora are small and named.** Page agent: 11 hand-picked hard pages (dense budget tables,
  dot-leader contents, statutory prose, two pure scans). Reader: 20 stitched documents. Cost
  shares: one 100-page US appropriations report with no charts. Nothing here is a claim about
  arbitrary PDFs.

## 8. What would change these answers

- **`gpt-5.6-luna` on `page` is a live question, not a closed one.** It is 30% cheaper than Kimi,
  ties it on both content kinds, and is declined on an accessibility count of 10-vs-7 across 11
  pages. Settling it needs a corpus with charts and images — which is also the corpus that would
  make the specialist and `builder` rows mean anything.
- **Re-derive the failed-spend figure after #300.** It is the one number here that is known wrong
  rather than merely old.
- **`copy_editor` is 25.0% and has never had a model round.** It is now the largest unexamined
  line on the bill; the three merged wins were all changes to its contract.
- **A `reader ×2` that dedupes by anchor** turns an 89%-of-floor result from a benchmark artifact
  into something shippable.
- **A swap invalidates the quality baseline, not just the cost.** `/v1/quality` reports a clean
  rate and mean rounds per document from the judge's verdicts; both swaps change what the judge is
  reading. Re-measure the week after, not the day after.

## 9. Re-running any of it

The rounds live in the benchmark repo (`equalify-iris-bench`), which drives this API rather than
importing Iris. Reading a captured round back costs nothing:

```bash
node --env-file=.env extractround.mjs runs-extract-ad3e7a6 --dry   # the page table, free
node src/report.mjs --runs runs-bystep-100                         # the cost shares, free
```

The second one regenerates that directory's `summary.json` and `results.jsonl` from the per-chunk
records it keeps. The figures come back identical, but the two files' timestamps do not — so read
a round's date off its `ledger.jsonl` (or the chunk directories), never off the summary.

A single arm of the page round is about $0.20 with `--probe`. The full 100-page round is about
$18. Every round directory carries `records.jsonl` with the per-row model, sha, token counts and
price, and the raw model replies are in its `logs/` — which is what makes a paid round regradable
for free, and what every number above was re-derived from.
