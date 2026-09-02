# Equalify Iris — which model runs which agent

Iris dispatches five agents plus any specialist a page names, and a deployment can point each
one at a different provider and model with one line of `providers.per_agent` (PRD §10.3,
`config.example.yaml`). This document is the answer to "which line should I write, and what does
it cost" — the outcome of the model-selection sprint tracked in
[#246](https://github.com/EqualifyEverything/equalify-iris/issues/246) and reported in
[#311](https://github.com/EqualifyEverything/equalify-iris/issues/311).

Four of the five agents have a cheaper model in play, and no two of the four are at the same stage.
**One was applied, one was declined, one is recommended and waiting on a decision, and one is
open** — and none of the four was the same kind of decision.

- **`page` is swapped and live.** `moonshotai.kimi-k2.5` has served the reference deployment's page
  agent since 2026-09-02
  ([#312](https://github.com/EqualifyEverything/equalify-iris/issues/312)). On 11 hard pages it
  measured at-or-better on cost, word recall, first-pass rate and three of the judge's four defect
  kinds (§2). On **100 pages of the live deployment** it measures **−44.8% of the priced model bill**
  and a content loss the small round could not see: Iris's own unchanged verifier reports
  `content_missing` on **42 pages against the incumbent's 15**, and the specific thing missing is
  the regional subtotal rows of statistical tables
  ([#324](https://github.com/EqualifyEverything/equalify-iris/issues/324), §5). Whether that trade
  is acceptable is a judgement about what a deployment is for; it is not settled here.
- **`reader` was declined.** It was the cheapest defensible cut on paper — 78% of the incumbent's
  own agreement floor for 77% less money — and the decision went the other way once the loss was
  broken out by kind
  ([#313](https://github.com/EqualifyEverything/equalify-iris/issues/313), §3).
- **`copy_editor` is recommended for a swap and nothing has been applied.** `openai.gpt-5.6-luna`
  costs 9.5% of the incumbent per document and is ahead on *both* quality halves — **21 of 23
  provable defect instances against 12** on the one measure whose denominator is the same for both,
  corroborated by obedience to the issue list (5 of 6 documents against 3 of 10) — worth about
  **−26.1% of the bill §5 prices**
  ([#329](https://github.com/EqualifyEverything/equalify-iris/issues/329), §4). That result only
  appeared once the benchmark attached the page images Iris attaches; the round that withheld them
  ranked the two the other way round, which §7 carries as a limit in its own right — a benchmark
  that withholds an input the agent receives in production measures a different agent.
- **`feedback` is open, and it is the one line of this document that has had to retract its own
  published reason.** The keep rested first on a circular argument and then on **57 of 57 injected
  defects, no misses** — a figure taken on 11 hand-picked pages. The same injector on **45 pages**
  gives 40 of 45 against the cheap finalist's 39 of 45, a tie, and adjudicating the pages where the
  two disagree found the cheap model's extra rejections were mostly **real defects the incumbent
  passed** ([#330](https://github.com/EqualifyEverything/equalify-iris/issues/330), §4). Neither a
  keep nor a swap is defensible from what has been measured, and §4 names the two unmeasured things
  that block the swap.

Read §2, §3 and §4 before revisiting any of them. The one agent not on that list is `builder`, which
has made two model calls in the whole sprint — both of them on the swapped deployment, which is why
§0's zero for it is a zero with a date on it rather than a property of the agent (§4).

**Every figure here names the benchmark round it came from**, because some of them are stale by
design and several are superseded outright — §6 says which. **"The incumbent" below means the
unswapped Sonnet-4.6 baseline every round was measured against** — not the reference deployment as it
stands today, whose `page` agent has run on `moonshotai.kimi-k2.5` since 2026-09-02, and not
`config.example.yaml` as shipped either: that file's `providers.default` is `openrouter`, so its
capabilities resolve to `anthropic/claude-sonnet-4.6` and the Bedrock id `us.anthropic.claude-sonnet-4-6`
is only the `bedrock` block's default. Same model generation, two providers and two ids — a
distinction §1 spends a paragraph on, because a Bedrock id under an OpenRouter default does not
resolve.

## 0. The short version

| agent | share of the bill, unswapped | status |
|---|---|---|
| `page` | **42.0%** | **swapped and live since 2026-09-02** (#312) — −44.8% of the priced bill measured on 100 pages, at a named content cost: `content_missing` on 42 pages against 15 (§5) |
| `copy_editor` | **33.1%** | **swap recommended, not yet applied** (#329) — `openai.gpt-5.6-luna` at 9.5% of the cost and *ahead* on both quality halves, once the page images the agent actually receives are attached (§4) |
| `feedback` | 15.6% | **open** — the keep this row used to assert has been retracted twice over (#330): its reason was circular, and the 57/57 that replaced it was an 11-page artifact. On 45 pages it is 40/45 against the cheap finalist's 39/45, a tie; the incumbent's one surviving lead is numbers in tables, 12/14 against 9/14, for ≈$1.7–1.9 per 100 pages (§4) |
| `reader` | 9.3% | **declined** (#313) — 78% of the incumbent's own agreement floor at −77%, and §3 says what the 22% is |
| `builder` | 0% | 0 in this round, **not zero any more**: it ran twice on the swapped deployment, at about $0.04 a call (§4) |
| specialists | 0% | still 0 calls, and §4 says why that is a fact about `agents_dir` rather than about the corpus |

Shares are of **$19.3951 for 100 pages ($0.1940/page), `runs-bystep-now` at `3749f54`** — the
unswapped deployment, so they are the shares the two decisions **already taken** — `page` and
`reader` — were weighed against. The `copy_editor` recommendation is priced on a different round
(`runs-postswap-312`, §4), so its −26.1% is not a share of this column and does not belong in it. They
partition that round's priced spend and sum to 100.0%. They are **shares, not prices**, and the
swap has since moved them: §5 has the post-swap partition, in which no agent is above 29%.

**"78% of the incumbent's own agreement floor" is a ratio of two agreement rates, not a miss rate.**
Kimi reproduces 118 of 180 reference findings (65.6%) and the incumbent's own second pass reproduces
152 (84.4%); 65.6 ÷ 84.4 = 78%. Read bare, that sounds like losing a fifth of the issues; the
absolute per-issue miss is **34%**. §3 gives the paired figure, which is the one that charges a swap
for its own losses rather than for the reference's irreproducibility.

The applied swap is one line of `per_agent` — and on the reference deployment it took two, which is
the paragraph under the block, not a footnote:

```yaml
providers:
  per_agent:
    page: { provider: bedrock, model: moonshotai.kimi-k2.5 }
```

On a deployment whose `providers.bedrock` block is Anthropic-native it is **two** lines, because
`api: converse` is needed for a non-Claude id and that key is **block-wide** — it moves every
agent's transport, not the one named. §1 has the rest of the ways this edit goes wrong.

## 1. The knob, and the ways it fails

`resolveAgentModel` (`src/providers/index.ts`) resolves a model from **agent name and capability
only**. The `{ step }` on a `router.complete` call is telemetry — it feeds `by_step` in
diagnostics — and routes nothing. So the swappable unit is the agent, and there are five the code
dispatches:

| agent | dispatched from | job |
|---|---|---|
| `page` | `src/pipeline/extraction.ts` | the page → HTML pass, the correction of a page that failed verify, and the merge of a specialist's fragment back into the page |
| `reader` | `src/pipeline/review.ts` | reads the assembled document and reports issues |
| `copy_editor` | `src/pipeline/review.ts`, `src/pipeline/tables.ts` | applies the review, and merges a table split across a page break |
| `feedback` | `src/pipeline/feedback.ts` | VERIFY / CLASSIFY / TRAIN — the judge |
| `builder` | `src/pipeline/contribute.ts` | drafts a specialist agent file for a content type a page asked for |

plus any specialist named by a page suggestion, whose key is the file stem in `agents_dir`
(`chartDataAgent` is the only one shipped). `copy_editor` is **one line for two jobs**, so the
review round and the table merge cannot be put on different models.

**A key naming anything else is ignored, and the run does not fail.** The call finds no override
and falls through to the provider's own `per_capability`/`default_model`, so the document arrives
at the price it would have cost anyway. This matters most to exactly the reader of this document:
**an unchecked typo in a swap reads as "the cheaper model did not save anything."** Two things say
otherwise, and neither is the run stopping, so a swap has to be checked rather than assumed. Boot
warns about a key it cannot route (`perAgentKeyWarning`, `src/config.ts`) — check the log line once
after editing, and note that it warns rather than refuses, because a specialist's name is a file on
disk and the valid set is therefore open. Afterwards, diagnostics names the model each agent ran on
(below).

**A model id belongs to a provider, and nothing checks that it belongs to yours.** An override
that sets only `model:` keeps `providers.default` and passes the id through as written
(`resolveAgentModel` again). `moonshotai.kimi-k2.5` is a **Bedrock** id, so that one line on a
deployment whose default provider is OpenRouter sends it to OpenRouter, which does not have it.
That one fails loudly rather than silently — but it fails on every call of the run, so it is worth
not writing. Both snippets in this document name `provider:` as well as `model:` for that reason,
and they name it even where the deployment's default is already `bedrock`: the line then says which
price sheet its numbers came from.

**How to tell afterwards whether the swap happened.** Diagnostics reports `models` per agent —
`by_agent.<agent>.models` names the model ids that answered that agent's calls (`GET
/v1/sessions/{id}/diagnostics`, docs/API.md §7b). A `page` row still naming the incumbent after an
edit is a swap that did not take effect; the boot warning says which key is wrong beforehand, and
this says what actually ran. One id is the ordinary case, and more than one is not a defect:
resolution keys on capability too, so a provider's `per_capability` block can put one agent on two
models deliberately — which is also how a swap reaches a call site no round has measured. **Read
it on a session that has only run since the edit.** Like the seven numbers beside it, `models`
folds every call in the session's log, and a session's log spans its feedback rounds as well as
its first run — so a session extracted before the restart and given feedback after it holds both
ids honestly, and that is the one case where two ids mean a change of config rather than a split
by capability. A fresh document after the restart cannot be read either way. The
`page` entry moves all three of the call sites in the table above, and the round in §2 covers two
of them; the specialist merge is a `text` call and no round's corpus has produced a specialist call
at all. **That third site is live on the reference deployment and still unfired**, for the structural
reason in §4 rather than for want of a corpus. Note that `/v1/quality` cannot answer this — it
carries no per-step breakdown, so `by_step` has to be read per session (docs/API.md §7b).

## 2. `page` — the largest line on the bill

**`page` (42.0%) — swapped and live, and whether it stays is still open
([#324](https://github.com/EqualifyEverything/equalify-iris/issues/324)).** The 11-page round below
is what the decision was taken on; §5 is the 100-page round that priced it afterwards and found the
content cost the small round could not see. Read both before revisiting it.

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

Kimi is the only non-incumbent arm at-or-better than the incumbent on recall, first-pass rate and
three of the judge's four kinds at once. `structure_wrong` is the fourth, and Kimi is worse on it
(9 against 7).

**This round is why the swap was applied, and it is not why it should stay.** The 100-page round on
the swapped deployment reports `content_missing` on 42 pages against the incumbent's 15 — the kind
this table has at **5 against 6**, i.e. the direction reversed at scale (§5,
[#324](https://github.com/EqualifyEverything/equalify-iris/issues/324)). Eleven pages could not
separate them; a hundred could. Read §5 before quoting any row above as a quality result.

**The −56% is measured against an incumbent that had its prompt cache, and the swap gives that
up.** `cacheableSystemPrompt` (`src/providers/promptCache.ts`) returns false for any id it cannot
read as a Claude model, so a non-Claude `page` model gets no breakpoint at all — not on
`agents/page.md`, not on anything else that call sends twice. The round's own call lines show both
sides of it: across the incumbent arm's 21 page calls, **283,290 of its 333,958 prompt tokens
(84.8%) were billed as cache reads** at a tenth of the input rate, while Kimi's 21 carried
**351,841 input tokens and no cache reads at all**. Priced from those lines the incumbent arm is
$0.6722 and Kimi $0.2944 — $0.0611 and $0.0268 a page, which is where the table above gets its two
figures. The lost breakpoint is therefore **already inside the −56%**, and that is the most
conservative of the three comparisons this round supports:

| the incumbent priced… | $/pg | Kimi against it |
|---|---|---|
| as billed, on a warm cache — what this section reports | $0.0611 | **−56%** |
| cold start: one write of the 13,490-token prefix it reused | $0.0657 | −59% |
| with no cache at all | $0.1306 | −79% |

The middle row exists because the incumbent arm recorded **0 cache-creation tokens** — it inherited
a warm prefix from an earlier round inside the TTL, so its price leaves out the one write a first
run pays. Both residuals move the same way, so a deployment should expect the swap to save at least
what is published here and possibly more.

Free to re-derive, and worth re-deriving before quoting: the numbers are the `model_call` lines with
`agent: "page"` in `runs-extract-ad3e7a6/logs/<model>__p1-11.jsonl`, summed over
`input_tokens`, `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` and
priced with the bench's own `src/pricing.mjs` against `rates-bedrock.json`. A live deployment reads
the same four counts per agent out of `by_agent` (§1).

**What this does not establish, and one thing it got wrong.** An earlier version of this section
summarised the table as "no net quality loss". That was defensible on 11 pages and it is false on
100: see the paragraph above and §5. The lesson is the one worth carrying — a defect kind that
differs by one on a small corpus is not a tie, it is unmeasured. Recall is over 9 scored pages — the two `acir-scan` pages are
pure scans carrying `truth_words: 0` by design, and every arm produced a judge-rejected page on
both. A 25-vs-29 difference in flags across 11 pages is not statistically separable and is not
claimed to be; the claim is that Kimi is not *worse* at 56% less. And the judge is the incumbent
model grading a rival — worth naming, though it raised 29 flags against its own output and 25
against Kimi's, so it is not sparing itself.

## 3. `reader` — the cheapest defensible cut

**`reader` (9.3%) — declined, on the shape of the loss rather than its size
([#313](https://github.com/EqualifyEverything/equalify-iris/issues/313)).** It was the best-looking
cut in the sprint on a single aggregate and the decision reversed once the same loss was broken out
by defect kind, which is the reason this section is longer than the saving would justify.

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

**`kimi ×1` was proposed and declined**
([#313](https://github.com/EqualifyEverything/equalify-iris/issues/313)): 78% of the floor at
$0.0216/doc, −77%, and the same single `per_agent` line the page swap took — `kimi-k2.5` is a Bedrock
non-Claude id here too, so on an Anthropic-native block it needs `api: converse` as well (§0). The
table above is the case for it. Here is
what settled it against, and none of it needed another round — the loss was broken out by kind from
the rounds already on disk:

The reference is **180 anchored issues**, and the two loss columns below are in different units, so
neither is the other's complement. *Issues missed* is `180 − reproduced`. *Findings lost* is that
set with the duplicates taken out: the reference states some findings more than once in a document,
and `readermissed.mjs` drops a missed issue whose finding the arm caught in a different issue of the
same document — 7 such for `kimi ×1`, 2 for the control, 3 for `kimi ×2`. Both percentages are over
the 180-issue denominator, which for the findings column is a mixed rate; the count is the number to
read.

| | reproduces the 180-issue reference | issues missed | findings lost, dedup'd | $/doc |
|---|---|---|---|---|
| incumbent ×1 — the reference | — | — | — | $0.0938 |
| **incumbent ×1 again — the control** | 152/180 = 84.4% | 28 (15.6%) | 26 (14.4%) | $0.0924 |
| **kimi ×1** | 118/180 = 65.6% | 62 (34.4%) | 55 (30.6%) | $0.0216 |
| kimi ×2 | 135/180 = 75.0% | 45 (25.0%) | 42 (23.3%) | $0.0415 |

**The swap's own cost is the paired figure: 34 findings — 18.9% of the reference — that Kimi loses
and the incumbent's own repeat keeps.** Not "a fifth of the issues", and not 55 − 26 either: the
control's losses are not a subset of the arm's, so two counts over one denominator do not subtract
into a paired count. Of the 34, **7 are high severity**, and reading those 7 rather than counting
them is what decided it. All seven, by kind: an empty `<h1>` (a page-break element carrying both
`role="doc-pagebreak"` and a heading role); link text broken mid-word, so the accessible name is a
word fragment; pages of body text with no headings at all; dozens of one-word `<h3>`s on one page
against the same content as a paragraph in a single table cell on the next; a page of garbled
repeated body text; and **two findings of data tables emitted as absolutely-positioned paragraphs
with no table element, no headers and no caption**. Those last three kinds are exactly what the
editor and `tables.ts` exist to act on, so they are not a cosmetic loss.

**The deciding reason is not the price, though.** A bad `page` extraction moves five counters a
deployment already records — `pages_verify_failed`, `pages_unreadable`, `reextracts`,
`corrections_refused`, `model_mismatch` — so a swap there fails loudly. **A reader that misses a
finding moves nothing**: the document converts, the editor has nothing to act on, and the loss
exists only against a run nobody made. That asymmetry is why the cheaper agent with the bigger
prize was swapped and the cheaper agent with the smaller prize was not, and it would hold at 90%
of floor too.

**The two-pass form is not a config change, and it does not buy this back.** It reaches 89% of the
floor for $0.0415 (−55%), but Iris would have to sample each window twice *and* dedupe by anchor;
`dedupeNoContentIssues` (`src/pipeline/review.ts`) does not do that — it is scoped to no-content
reports. Against the 34-finding paired subset a second Kimi pass recovers **10**, still loses
**24**, and still misses **4 of the 7** high-severity findings. So the 89% headline adds volume
where the two passes already agree. If the anchor-level dedupe is worth building, it is for some
other reason than this swap.

**A cheaper reader makes the deployment's quality numbers improve, and that is the trap — it is why
this swap needed a break-out by kind rather than a dashboard.** A third of the issues the incumbent
would have raised are not raised, and an issue that is never raised is never left open: the document
ships with an empty `@unresolved` list
and a `clean` exit, which is the same reading a document gets when the editor fixed everything. So
`unresolved_rate`, `unresolved_severity` and the `clean`/`converged` split all move in the direction
`.github/workflows/quality-report.yml` treats as good, and #264 — an open issue about that rate
being too high — would appear to have been answered by paying less. The number that does not move
that way is `first_read.mean_issues` in `/v1/quality` (`docs/API.md` §0c, PRD §7.16 v1.10): issues
raised by the review's first read, per document, recorded before any of them were fixed. Read it
across any reader change, with `first_read.unread_documents` next to it — a fall in the mean with
that count rising is a reviewer that could not answer, and a fall with it flat is a reviewer that
found less, which is the loss this table has priced. The bench figure and the deployment's figure are
not the same measurement (20 stitched documents against a reference issue set, versus every document
a deployment converts), so the check is a change of level across the config edit, not a number to
compare with 78%.

**Kimi ×2 beats haiku ×2 on both axes at once** — more agreement for less money — so haiku is not
on the frontier for this agent at either pass count.

The ordering survives a change of reference, which is the only reason to trust it: scored against
the *other* pass's issue set instead (floor 148/170 = 87.1%), the four Kimi and luna arms come out
84% / 72% / 70% / 57% — different numbers, same order. That check covers Kimi and luna only;
haiku's rows are absent from that second artifact as it now stands, though its two passes are both
in the round's records and priced.

## 4. One swap recommended, one decision reopened, and two zeros

**`copy_editor` (33.1%) — a swap to `openai.gpt-5.6-luna` is recommended and has not been applied,
and this row said "keep" for as long as the benchmark withheld an input the agent gets in
production.** Every win on this agent up to that point came from changing what it is asked to do,
not who does it: table joins moved into code
([#278](https://github.com/EqualifyEverything/equalify-iris/issues/278) — 62% of split tables
joined at $0, 0 refused by Iris's own `verifyJoin`, with the measured caveat that the code path
keeps the first half's header and one joined document read "19592"); the editor patches blocks
instead of retyping the document (#277, #258 — 22%, after the finding that 44% of documents could
not fit the reply at all); and a truncated reply's completed blocks are now applied instead of
thrown away (#300).

**Two rounds have now run, and the second reversed the first.** `runs-editor-1` (2026-08-30,
$3.58, seven models, 20 documents) sent the editor the document and the issue list and **no page
images**, and could not separate its finalists. `runs-editor-2`
([#329](https://github.com/EqualifyEverything/equalify-iris/issues/329) — 2026-09-02, $2.6059,
iris `2566c8b`, block contract, 40 calls, 5–11 real page renders per call in assembly order, capped
at Iris's own 12) attached them and separated the finalists in the opposite direction. On the two
measures taken on documents that carry issues — which is every document Iris sends this agent:

| with page images attached | resolved, of 23 provable defect instances | edits confined to blocks an issue named | $/doc on the 15 documents Iris feeds the editor |
|---|---|---|---|
| **incumbent** `us.anthropic.claude-sonnet-4-6` | **12 of 23** (22 without images) | 3 of 10 — **30%** | $0.1172 |
| **`openai.gpt-5.6-luna`** | **21 of 23** (16 without images) | 5 of 6 — **83%** | **$0.0111 — 9.5%** |

**The capability column is the one to weigh, because it is the only one of the three whose
denominator is the same for both rows.** 23 provable instances, same corpus, same grader, one
number each. The confinement column's denominator is **set by the subject** — a model that declines a
document has no edits to be confined, so Luna's obedience is scored over 6 documents and the
incumbent's over 10 — and §4's own verifier section rejects exactly that shape for
`heading_flattened`. The gap is wide enough that the direction is not in doubt; the 83%-against-30%
*ratio* is not a like-for-like comparison and should not be quoted as one.

**The incumbent gets worse when it is shown the page**, 22 → 12, and the mechanism is legible in
the replies: it spends edits rewriting blocks no issue named and does not reach the block that held
the defect. It is doing something defensible — reading the page and reporting what it sees — and
this step's contract does not ask for it. The issue list is what a Reader raised, and an edit
outside it is unrequested by definition.

Carried to the shipped deployment, where `copy_editor` is $3.0849 of the **$10.7106 §5 prices for
four agents**: **$3.0849 → ≈$0.29, so $10.7106 → ≈$7.92 and $0.1071 → ≈$0.0792/page — a saving of
$2.79 per 100 pages, −26.1% of the priced bill and ≈−25.9% of the round including `builder`
(≈$10.79).** Both are quoted because they are different denominators and this document has already
published one as the other once (§5, §7). That is the largest single move left, and unlike the `page`
swap it carries no quality debit: it is a credit on both halves. What it does *not* license is a
prediction of what `copy_editor`'s share becomes — a share is a ratio, the other agents' dollars are
unchanged, and the denominator moves (§7).

**Three things the round does not settle, and one it hands to the pipeline.**

- **The loudest number in #329 is off-distribution.** Luna declines 8 of 8 clean documents against
  the incumbent's 1 — a striking result on an input Iris does not produce, because
  `src/pipeline/review.ts` breaks out of the loop when the Reader raises nothing rather than handing
  an editor an empty issue list. Read it as a clean demonstration of a mechanism, never as a rate.
  Confinement, in the table above, is the on-distribution form of the same question.
- **One document carries the capability gap.** `amazon.nova-2-lite-v1_0` is 8 of the 23 instances
  and accounts for −8 of the incumbent's −10 and **+6 of Luna's +5** — a component larger than the
  net it sits in, because Luna also lost one instance on `nvidia.nemotron-nano-12b-v2` (8 → 7), and
  the incumbent's other −2 is one instance each on that document and on
  `anthropic.claude-sonnet-4-6`. The *direction* is corroborated by obedience to the issue list and
  by the other documents; the *size* does not survive dropping it.
- **Luna's rate is substituted from us-gov-west-1** (`not sold in us-east-1`), and its input side
  gets no prompt-cache discount at all, because `cacheableSystemPrompt` is false for a non-Claude
  id. The quality result does not depend on the price; the −26.1% does. The free check still
  outstanding is the deployed editor's own cache-read share: if the incumbent is cache-heavy there,
  its real $/doc is under $0.1172 and −26.1% is optimistic.
- **The incumbent demoted five real headings on a document nothing had flagged, and nothing gated
  it** — `<h2>Standby Pay.</h2>` → `<p><strong>…</strong></p>` with `word_delta: 0` and the prose
  byte-identical in length, on a stated reason that is false (`li`'s content model is flow content,
  so a heading in a list item is valid HTML). `navigation_lost: {headings: 5}` was logged and read
  by nobody. That is [#331](https://github.com/EqualifyEverything/equalify-iris/issues/331) and it
  is deliberately **not** part of this recommendation: the guard is worth having whichever model
  ships, and a guard that only matters for the model you are replacing is the one that never gets
  written.

**`feedback` (15.6%) — open, and both of the reasons this section has given for keeping the incumbent
have been retracted.** The first was circular: "treat a swap here as a change to the instrument" is an
argument for measuring carefully rather than evidence about the choice — being the oracle is a
*consequence* of the choice, so it cannot justify it
([#330](https://github.com/EqualifyEverything/equalify-iris/issues/330)). The second is what this
section published in its place, and it survived about an hour: **57 of 57 injected defects, no
misses**. That was true of 11 pages and false of the class. The seat that ran the round widened the
corpus, retracted the headline and withdrew its own recommendation rather than restate it, and
declined to flip to a swap — so the honest disposition is *undecided*, and what follows is written to
be acted on in that state rather than to defend either answer.

The method is right and is unchanged: **inject a known defect and ask each candidate whether it sees
it**, where ground truth is the injection and the incumbent is not the reference anywhere in it. What
moved is the corpus. `runs-verifier-1` (2026-08-30, **645 calls, $6.4739**, iris `da78e0b`, five
models, five defect classes, three repeats each, plus three undamaged controls per page) ran on **11
hand-picked hard pages**, driven through Iris's own `verifyAgentOutput` with one page image and the
page agent's whole contract per call. `runs-digits-45` (2026-09-02, **360 calls, $6.8797**, iris
`2566c8b`, `agents/feedback.md` at `b4b2d3ca`) ran the `digits_changed` injector the same way against
**45 pages** — every page of a real 91-page 1962 statistical report that carried a breakable figure —
one repeat per page, both finalists.

| `digits_changed` detected | 11 hand-picked pages | **45 pages** |
|---|---|---|
| **incumbent** `us.anthropic.claude-sonnet-4-6` | 9 of 9 — no misses | **40 of 45** |
| `openai.gpt-5.6-luna` | 6 of 9 | **39 of 45** |

Paired by page over all 45: both 35, only the incumbent 5, only Luna 4, neither 1. **Five discordant
pages against four is not a separation.** The two misses hardest to defend are the incumbent's —
`1,000 → 1,500` and `800,000 → 850,000` — and a follow-up round on the 10 disagreement pages at three
repeats each (`runs-digits-repro`) missed both 3 times out of 3, with only 1 of its 10 cells unstable.
That is a blind spot rather than bad luck: the same verdict the earlier round reached about Luna, now
true of the incumbent, so **reproducibility does not favour it here either**.

The tie is two real effects cancelling, and this split is the part that still decides something.
Classified by the injector's own rule on the *original* token — a year has no comma and falls in
1900–2100, everything else is a figure:

| | table figures (n=14) | years (n=31) |
|---|---|---|
| **incumbent** | **12 of 14** | 28 of 31 |
| `openai.gpt-5.6-luna` | 9 of 14 | **30 of 31** |
| paired | both 7, **only the incumbent 5**, only Luna 2, neither 0 | both 28, only the incumbent 0, **only Luna 2**, neither 1 |

**A number inside a table is the class this pipeline exists to get right**, and it is the only class
where the incumbent's lead survives the wider corpus. One `digits_changed` rate hides both directions
at once. Both models' misses share a shape — a round number replaced by another round number — and
one page (`1959 → 1459`) was missed by both.

**Nothing wider than 11 pages is known about the other two classes.** The retracted 57 of 57 pooled
`digits_changed`, `para_deleted` and `row_deleted`; only the first has been re-run at 45 pages, so the
other two are neither confirmed nor retracted — they are an 11-page measurement, and this is what the
11-page round still supports:

| verifier, 11 pages, `runs-verifier-1` | `para_deleted` + `row_deleted` + `digits_changed` (**superseded** for digits) | contradicts itself on identical HTML | $/call |
|---|---|---|---|
| **incumbent** `us.anthropic.claude-sonnet-4-6` | 57/57 | **1/25 = 4%** | $0.0207 |
| `openai.gpt-5.6-luna` | 53/57 | 3/29 = 10% | $0.0073 |
| `anthropic.claude-haiku-4-5` | 47/57 | 7/26 = 27% | $0.0068 |
| `amazon.nova-2-lite-v1:0` | 18/57 | 9/31 = 29% | $0.0025 |

Two of that round's five classes come out of the pooled column before it means anything, and both
exclusions cut against the incumbent's case rather than for it. `alt_gutted` is no longer a model's
job — #290/#291 shipped `src/pipeline/alt.ts`, a closed word list that catches `alt="image"` on every
page at $0 — and it was the class the incumbent was *weakest* at, so removing it flatters the
incumbent (97.1% against Luna's 87.7%). `heading_flattened` is not comparable across models, because
the *undecidable* count is itself a model behaviour: from the same 33 draws the incumbent's
denominator is 12 and Luna's is 24, and a row whose denominator is set by the subject cannot rank
subjects. `amazon.nova-2-lite` is not a cheap verifier on any reading — it passes 25 of 33 undamaged
pages and finds 23.7% of injected damage — and #291's word list now does more for $0.

**The reading that inverted, and it is the one this document had leaned on twice.** Both rounds show
the cheap finalist rejecting far more undamaged control pages: on `runs-digits-45`'s controls it fails
84.4% of calls against the incumbent's 52.6%, passing 1 page of 45 on all three calls against the
incumbent's 20. This section previously called that a specificity cost. **All 12 pages where the two
disagree completely — Luna failing 3 of 3, the incumbent passing 3 of 3 — have now been adjudicated
against the delivered files, and all 12 carry a real defect the incumbent passed three times each.**
Among them: the word **`necessarv`** shipped in place of `necessary`; **eight fabricated regional
total rows** in a statistical table; an inserted word (`about a 4.5 cents per pack`); a lettered list
rendered as `1. (a)`; alt text repeating all 13 content words of its own figcaption; and four pages
whose section headings are italic text with **no heading element anywhere in the file**.

So the control column does not measure specificity. On those 12 pages the incumbent's pass *is* the
miss, and its 47.4% is a blend of correct passes and false negatives that the number alone cannot
separate. The other 33 pages are unadjudicated in both directions, and an undamaged control is not a
correct one — these are real Iris outputs, not verified-clean fixtures.

Two things still block a swap, and neither is measured:

- **Rejecting 84% of pages is an action, not an opinion.** #288 measured the correction pass clearing
  the verifier on 26% of the pages it is bought for, so a more accurate verifier at this rejection
  rate mostly buys corrections that do not clear — and on a deployment running one review round
  (UIC's `max_review_iterations: 1`) it instead ships those pages carrying unresolved flags. **A
  verifier being right more often is not the same as being worth acting on more often.**
- **Luna's errors are the expensive kind.** Two of the 12 pages also carried an invented defect — a
  sentence claimed missing that is in the file, a colon claimed inserted that is not — and a false
  `content_missing` sends a correction pass to add text nobody dropped. Two instances in 45 pages is
  not a rate this round can bound. One further caveat is the harness's, not the model's: it hands the
  verifier bare HTML with none of the page agent's JSON log envelope, which Luna complains about on 16
  of 135 control calls against the incumbent's 6 — but only 2 calls fail on that ground alone, so it
  does not explain the rejection floor.

**The price gap is unchanged in size; what it buys is what changed.** Luna is **$0.0086 a call against
$0.0296** on `runs-digits-45` — **29.0%** — against 35.3% on the 11-page round, and it earns 33.9%
cache reads while paying 1.5M cache-write tokens where the incumbent gets 79.7% with none, so the
ratio is measured at Luna's *worst* caching. Over the ~90 verify calls the deployment makes per 100
pages, the incumbent's premium is **≈$1.65 at the older round's ratio and ≈$1.81 at this one's — so
the $1.65–$1.90 range this section used to publish still holds, at −15.4% to −17.7% of the $10.7106
§5 prices and ≈−15.3% to −17.6% of the ≈$10.79 round including `builder`**. It is no longer buying
"misses nothing"; it is buying 12 of 14 table figures against 9, at the cost of passing pages that
carry defects.

**A cheap screen escalating to the incumbent was priced and declined**, at the 11-page round's rates.
The verifier rejects 65 of the 90 pages it judges, so Luna on all 90 plus the incumbent on ~72% of
them is $0.90 + $1.84 = **$2.74 against $2.55 for the incumbent alone** — more expensive, and it still
ships the screen's misses, because a defect the screen does not flag is never escalated. A triage tier
can beat its cheap tier on cost but never on detection; the same shape lost in #317.

**One defect in the incumbent that no corpus change touches:** `problems` is used as a scratchpad, and
items retract themselves and are emitted anyway ("Disregard — not a problem", on all three calls of a
page whose marker is correct). Measured over `runs-digits-45`: 19 of 180 calls, 32 of 350 items
(**9.1%**) and **14.8% of problem text**, against 0 for Luna. No page in the round was failed on
retracted items alone, so the cost is output rather than accuracy — on a line whose output half is
44.1% of its price, and every retracted item is handed to a correction pass as something to fix. A
prompt clause fixes it for $0.

**And if the verify line has to come down, the lever is the number of calls, not the model.** It is
one full vision call per non-blank page; #294 already took 9% out by not verifying blank versos. That
direction has no detection cost and has not been benched.

**The largest thing this round found is not about the verifier at all.** Twelve of twelve disputed
pages carry defects in Iris's own page output — a misread word, fabricated table rows, an inserted
word, a broken list, alt text duplicating its caption, headings emitted as italics — and
[#333](https://github.com/EqualifyEverything/equalify-iris/issues/333) adds a sixth kind: the page
agent numbers 5 of 91 markers by file position instead of the printed folio, against a clause in its
own prompt. A verifier swap moves cents per 100 pages in either direction. These are defects a reader
can catch the service out on, and fixing the extraction is worth more than changing who grades it.

**`builder` (0% in this round) and specialists (0%) — one gate, two different reasons, and the
`builder` zero has since stopped being zero.** `runContribution` is called with the page pass's
`suggested_agent` list (`src/pipeline/orchestrator.ts`), and the `builder` call is made per
suggestion inside it, after a suggestion naming a content type the page pass already covers has been
declined. Both rows read 0 on every round of this sprint, and the reason given here used to be "a
corpus with no charts". **That reason was wrong, and the swapped deployment showed it:**

- The **swapped** page agent filed **two** suggestions from that round's pages —
  [#322](https://github.com/EqualifyEverything/equalify-iris/issues/322) (`censusDataTable`, from
  `p51-75-p7`) and [#323](https://github.com/EqualifyEverything/equalify-iris/issues/323)
  (`mapChart`, a choropleth, from `p76-100-p20`). **So the corpus does contain a chart**, and the
  gate does open on it. Both sessions' `by_agent` reads `page: moonshotai.kimi-k2.5`, which is how
  they are known to be post-swap sessions rather than inferred from the clock.
- `by_agent.builder` on those sessions: **1 call each, 2,013 input and 2,225 output tokens, on the
  incumbent model** — about **$0.04 a suggestion**, and a `contribute` step in `by_step` where no
  earlier round had one. Small money, but it is no longer an unmeasured agent.
- The **unswapped** arm of the *same* corpus filed none. One round per arm, so that is a signal and
  not a rate — but it is a behavioural difference the cost table cannot show, and it means a swap
  can add an agent to the bill as well as re-price the ones already on it.
- **Specialists are still 0, for a reason that has nothing to do with the corpus.** A suggestion
  produces a `builder` draft and a GitHub issue; it does not produce a specialist call, because
  resolution is by file stem in `agents_dir` and `chartDataAgent` is the only specialist shipped. A
  page asking for `mapChart` finds nothing to call. That zero holds until a specialist file is
  merged, and it is why `specialist_merge` — a `page` call site, so one the swap moved — has never
  fired on any round: `by_step` on both post-swap sessions carries `contribute` and no `specialist`.

## 5. What the applied swap did to the bill, and what it cost

**This section used to be an extrapolation. It is a measurement now.** Two 100-page rounds over the
same corpus, paired document by document, one before the swap and one on the swapped deployment:

| | $/page | 100 pages | vs unswapped |
|---|---|---|---|
| unswapped — `runs-bystep-now`, `3749f54` | $0.1940 | $19.3951 | — |
| **`page` on kimi-k2.5 — `runs-postswap-312`, live deployment** | **$0.1071** | **$10.7106** | **−44.8%** |

Per agent, each priced at its own model's rate — the swap is confirmed **inside** the round from
`by_agent[].models` (§1) rather than assumed, with all 165 `page` calls answered by
`moonshotai.kimi-k2.5` and `feedback` / `reader` / `copy_editor` still on the incumbent:

| agent | unswapped | swapped | | share of the priced total, after |
|---|---|---|---|---|
| `page` | $8.1521 (158 calls) | **$2.6098** (165) | **−68.0%** | 24.4% |
| `copy_editor` | $6.4118 (28) | **$3.0849** (15) | **−51.9%** | 28.8% |
| `feedback` | $3.0226 (95) | $2.6125 (94) | −13.6% | 24.4% |
| `reader` | $1.8086 (33) | **$2.4034** (40) | **+32.9%** | 22.4% |
| total priced by the harness | $19.3951 | **$10.7106** | −44.8% | 100.0% |

**That total is four agents, and the swapped round ran a fifth.** `builder` answered twice on the
swapped deployment and `mixedcost.mjs` does not price it, so it is in neither column above: about
$0.04 a call at the incumbent's rate (§4), against nothing at all in the unswapped arm, which filed
no suggestions. Add it and the round's spend is **≈$10.79, ≈−44.4%** — small money, and named here
because it is the same defect §0's share test was written to catch. Every `−44.8%` and `$0.1071/page`
in this document is over the four priced agents; the share column above partitions that subtotal, not
the round.

**About two thirds of the saving is the agent that was swapped, and a third of it is an agent nobody
touched.** Of the $8.6845 saved, `page` is $5.5423 (63.8%), the unswapped `copy_editor` is $3.3269
(38.3%), `feedback` is $0.4101 (4.7%), and `reader` gives $0.5948 back (−6.8%). The projection this
section used to carry (−25%, and described as a *floor* that the lost prompt cache could only push
up) came in **too low, not too high**: the swapped agent's own contribution alone is
$5.5423/$19.3951 = −28.6%, so the floor held, and the reason it was beaten is worth keeping — **a
one-agent swap re-prices every agent downstream of it.** Kimi's markup is leaner, so the editor's job
got smaller — 28 calls
became 15, and both of the round's 32,000-token output-ceiling truncations disappeared, which is most
of `copy_editor`'s $3.33. That is luck rather than headroom: the largest surviving editor reply came
back at **30,909 of 32,000 tokens, 96.6% of the ceiling**
([#317](https://github.com/EqualifyEverything/equalify-iris/issues/317)). `reader` went the other
way, 32.9% dearer on 7 more calls, and the mechanism is a hypothesis rather than a finding. **So a
per-agent projection has no claim to be a floor in either direction.**

### The cost, from Iris's own unchanged verifier

Per page, paired on the same corpus
([#324](https://github.com/EqualifyEverything/equalify-iris/issues/324)):

| signal | unswapped | swapped | |
|---|---|---|---|
| **`content_missing`** | **15** | **42** | **worse on 4 of 4 windows** |
| `content_wrong` | 37 | 39 | flat |
| `structure_wrong` | 39 | 38 | flat |
| **`a11y_only`** | **37** | **29** | **better** |
| pages with no output | 0 | 1 | |
| pages the correction pass could not fix | 0 | 2 | |
| `editor_truncated` | 2 | 0 | |

This is not a worse model across the board — it is a model that **writes cleaner markup over less
content**. And the missing content is specific rather than diffuse: these are statistical tables of
states grouped into regions, and the region *subtotal* rows are what goes. On the largest window the
region rows fall **21.4%** while the state rows in the same tables stay **exactly flat**, which is
the control that makes it a finding rather than an aggregate. **The region label survives as a
rowgroup header, so the table still looks complete and no longer adds up** — the worst shape a loss
can take. Iris's verifier names it in prose, ran a correction, and shipped the page anyway.

Whole-document aggregates cannot see this: HTML length reads −16.6%, text characters read −2.7% or
*+0.5%* depending on whether HTML comments count, and ≥3-digit numbers are flat. The −6.5% in digit
characters is real and lives entirely in 1- and 2-digit tokens — which is what the dropped subtotal
values are.

### Against the target

#246 set the target at ~$0.02/page. The measured $0.1071 is **5.4x** that, so the remaining gap is
still not a model-selection problem — which is the most useful thing this sprint established. What
changed is where the gap lives: after the swap there is no single dominant agent left to swap (the
share column above), so the next win has to come from asking an agent to do less, as every
`copy_editor` win did (§4).

## 6. Where every figure comes from, and which are stale

| figure | round | Iris at | still good? |
|---|---|---|---|
| page $/pg, recall, flags | `runs-extract-ad3e7a6` | `ad3e7a6`, recorded in the round | **yes** — everything merged since is docs or the config warning |
| reader % of floor, $/doc | `runs-reader-newsha`, `-newsha2` | `e842faa`, recorded, code-identical to `ad3e7a6` | **yes** |
| cost shares (42.0 / 33.1 / 15.6 / 9.3) | `runs-bystep-now` | `3749f54`, recorded | **yes**, for the unswapped pipeline |
| $0.1940/page, $19.3951/100 pages | `runs-bystep-now` | `3749f54` | yes, unswapped — and superseded in practice by the row below |
| $0.1071/page, −44.8%, the quality deltas | `runs-postswap-312` | **`2566c8b`**, from the deploy log, not the round | **yes** — one round per arm, §5 says what that does and does not support |
| editor capability, confinement, $/doc | `runs-editor-2` | `2566c8b`, recorded in the round | **yes** — one arm per model, and §4 names the one document that carries the capability size |
| the editor round that could not separate its finalists | `runs-editor-1` | graded at `917bb38` | **no. Superseded** — it sent the editor no page images, so it measured a different agent (§7) |
| verifier `digits_changed` detection, table-vs-year split, control adjudication, $/call, scratchpad share | `runs-digits-45` (+ `runs-digits-repro`) | `2566c8b`, recorded | **yes** — 45 pages of one document, one repeat per page; `runs-digits-repro` is 10 selected pages at three repeats, so its detection rate is not a corpus rate and is not quoted as one |
| verifier self-contradiction, $/call, `para_deleted` + `row_deleted` | `runs-verifier-1` | `da78e0b`, recorded | **partly.** Its `digits_changed` column is **superseded** by the row above — 9/9 became 40/45 at 4x the corpus. The other two classes have never been re-run wider, and its *undamaged-control* column is measured against a superseded `agents/page.md` |
| cost shares (44.5 / 25.0 / 18.0 / 12.6) | `runs-bystep-100` | `158e3d9` (derived, below) | **superseded** by the row above; see the drift note |
| $0.1786/page, $17.86/100 pages | `runs-bystep-100` | `158e3d9` | **no. Superseded** — it was never a price to quote forward |
| "10.89% of spend bought nothing" | 63 rounds, mixed | pre-#300 | **no. Superseded — do not quote it forward** |
| specialists = 0 calls | every round | — | yes, and **the stated reason was wrong** — see §4 |
| `builder` = 0 calls | every round before `runs-postswap-312` | — | **no.** 2 calls on the swapped deployment (§4) |

**The drift in the older shares was predicted and the prediction was wrong, which is worth keeping
rather than deleting.** Those shares predate nine merged changes (#297, #298, #300, #302, #303,
#304, #306, #309, #310), and this section used to reason: #303 cut reader $/doc by about 13% and
#298 stopped sending blank pages to the judge, so `reader` and `feedback` must have fallen, so
`page` must be a *larger* fraction than 44.5% and both swaps slightly better than the table says.

Measured on `runs-bystep-now` (100 pages, same corpus, `3749f54`): **`page` 42.0%, `copy_editor`
33.1%, `feedback` 15.6%, `reader` 9.3%**, summing to 100.0%. `reader` and `feedback` did fall — and
`page` fell **too**, because `copy_editor` grew by eight points and absorbed the difference. **A
share is a ratio: the numerator falling does not make the share fall, and the two agents a sentence
names are not the only other terms in the denominator.** The consequence ran opposite to the
prediction — the reader swap was worth about seven points of the bill rather than ten, not more.
Keep the habit of saying which direction a guess is a guess in; that is what let the error be caught
at no cost.

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

**The same derivation names the sha for `runs-postswap-312`, and there it is the only route there is.**
A round driven against a deployment records the base URL and nothing about the build behind it — its
`meta.json` carries `base`, the PDF's own `sha256` and `parent_sha`, and no Iris sha — so no amount of
re-reading the round can produce one. The four chunks were submitted between 18:41:01Z and 18:57:06Z
on 2026-09-02, and the last successful "Notify UIC deploy" before that was **`2566c8b`** at 17:25:14Z,
with none after it during the round. That is the build the **swapped** arm was measured on — the
$0.1940 baseline it is compared against is `runs-bystep-now` at `3749f54`, the row above it. It is
deploy-log evidence rather than round evidence, which is a weaker link than the
`iris_sha` a local round records: it establishes what main had shipped, not that the box was serving
it. The swap itself is the exception — that *is* confirmed inside the round, from
`by_agent.page.models` (§5).

**Two numbers in [#311](https://github.com/EqualifyEverything/equalify-iris/issues/311) do not match
the round it cites**, and both are in the recommendations' favour. That report gives `page` 43.2% and
`copy_editor` 20.8%; `runs-bystep-100/summary.json` gives **44.5%** and **25.0%**, and its four
agents partition the round's spend exactly — $7.9453 + $4.4639 + $3.2086 + $2.2427 = $17.8605, the
round's whole priced total — where the report's four shares sum to 94.6%. 43.2%
is `runs-177`'s `page` share — an earlier round, 2026-08-25, $17.83 — and 20.8% does not match any
captured round's `by_agent`. Every share published here re-derives from a round's own summary and
sums to 100%; a set that does not is the tell.

Everything else in this document was re-derived from the round records before it was published
here: the page table in full (every price, recall, first-pass rate and defect count), the reader
column at its stated reference, both rounds' shas and totals, and the $/doc of every arm including
the two-pass sums. Two things in the sprint report were not re-derived and are marked where they
appear — the reader's second reference column, and the sprint-wide spend totals behind the 10.89%.

**§4's editor and verifier figures are the exception to that, and it is worth being exact about
what they rest on.** They were re-derived from `runs-editor-2`, `runs-verifier-1` and
`runs-digits-45` by the seat that ran them, not independently by the seat that wrote this section.
Every one of those rounds persists its raw model replies, so all of them regrade for **$0** — the
commands are in §9 — and each of the statistics that decides something (capability 21-vs-12,
confinement 83%-vs-30%, 40/45-vs-39/45 and its 12/14-vs-9/14 split, 4%-vs-10%) comes with a stated
denominator and a named exclusion. That is a weaker link than a figure this document derived twice,
in the same way §6's deploy-log sha is weaker than a recorded `iris_sha`, and it is recorded here
rather than smoothed over.

**One of those figures has already been retracted by the seat that supplied it**, within an hour of
this document publishing it: 57-of-57 became 40-of-45 when the corpus went from 11 hand-picked pages
to 45. The weak link is therefore not hypothetical, and the mitigation is the one in §7's last
limit — a single-round figure is provisional until a wider corpus has seen it, whichever direction
it points.

**Both rounds were also unpublished for days while this document asserted they did not exist**, and
that is the one class of error nothing in this repo can catch. Every other figure here is checked by
re-reading the round it names; a claim about the *absence* of a round names no round, so there is
nothing to check it against, and the table above lists only rounds that produced published figures —
so an unreported round is invisible in it by construction. When auditing this document, sort its
claims into ones that cite a source and ones that assert a negative. The negatives are the unaudited
set.

## 7. Seven limits worth knowing before re-benchmarking

- **There is a ceiling and it is about 84%.** The incumbent reader agrees with its own previous
  pass on 84–85% of issues. Every "% of floor" number is against that, not against truth. A raw
  agreement figure quoted without the floor beside it overstates the gap between models.
- **Every share needs its denominator.** 42.0% is of $19.3951 at `3749f54`. −44.8% is of the four
  agents the bench harness prices, which is ≈−44.4% of the round including `builder` (§5); −56% and
  −68.0% are of the page agent's own spend. 78% is of an 84% floor, and 18.9% is of a reference of
  **180 anchored issues** — over which §3's two loss columns are in different units, so neither
  complements the agreement rate. 10.89% was of $176.53 across 63 rounds. Those are six different
  denominators, and mixing them was the most common way a number went wrong in this sprint.
- **A share is a ratio, so it moves when any other term moves.** Predicting one agent's share from
  the commits that touched *that agent* is the mistake §6 records: `page`'s share fell while its own
  cost was untouched, because `copy_editor`'s rose.
- **A benchmark that withholds an input the agent receives in production measures a different
  agent, and no care taken inside the round can rescue it.** `runs-editor-1` sent the editor the
  document and the issue list but not the page images Iris attaches, tied four models on restraint,
  and could not separate its finalists. `runs-editor-2` attached them and separated the same two in
  the *opposite* direction — the incumbent fell 22 → 12 on the same corpus with the same grader (§4).
  The gap was named in round 1 and read as a scope note; it was the whole result. Before quoting any
  arm, diff what the harness sent against what the call site sends.
- **The oracle is a lower bound, and it is the incumbent — but that is a property of the shipped
  measurements, not a limit on what can be measured.** A flag on a page a human would pass is a cost,
  not an error, and the judge is never scored against itself anywhere in this document. That does not
  make the judge unmeasurable, which is what this bullet used to imply: `runs-verifier-1` scores five
  candidates against *injected* damage, where ground truth is the injection and the incumbent is not
  the reference (§4). The circle is escapable; it just had not been escaped in print.
- **The corpora are small and named.** Page agent: 11 hand-picked hard pages (dense budget tables,
  dot-leader contents, statutory prose, two pure scans). Reader: 20 stitched documents. Verifier:
  those same 11 hand-picked pages for four of five defect classes, and 45 pages of one 1962 report
  for `digits_changed`. Cost shares
  and the −44.8%: one 100-page US government statistical report — hierarchical tables of states
  grouped into regions, and at least one choropleth map (§4). Nothing here is a claim about arbitrary
  PDFs, and §5's content finding is on the hardest possible corpus for exactly that failure mode.
- **Every conclusion here that has since been re-measured on a wider corpus has moved, and three for
  three is not a coincidence.** `page` measured at-or-better on 11 hard pages, then showed
  `content_missing` on 42 pages against 15 across 100 (§2 against §5). The editor's two finalists tied
  on restraint and then separated in the *opposite* direction once the round sent the page images the
  agent actually receives (§4). The verifier "missed nothing" on 11 hand-picked pages and misses 5 of
  45 on 45 (§4). In none of the three did the wider round merely sharpen the earlier answer — it
  changed which model won, or what the trade was. **Treat any figure from a single narrow round as
  provisional in whichever direction it points**, including the ones in this document that favour a
  decision already taken; and prefer widening a corpus to adding repeats to a narrow one, because
  repeats tell you whether a miss is stable and only the corpus tells you whether the rate is real.

## 8. What would change these answers

- **Whether the applied `page` swap stays is the open question, and it is not a cost question.**
  −44.8% of the priced bill against the regional subtotal rows of a statistical report (§5). The
  revert is **two** config lines, not one: #312 set `providers.per_agent.page` *and*
  `providers.bedrock.api: converse`, and undoing only the model leaves every agent on a transport no
  round has measured for parity (§1, #178). Two things would settle it better than another price round: a
  second post-swap round to put an error bar on `content_missing` 15 → 42 (~$10.70), and a
  prose-heavy corpus, since this one is the hardest possible case for exactly that failure mode.
- **A page Iris knows it could not fix is indistinguishable, in the delivered document, from one it
  never doubted.** Two pages shipped after `page_correction_failed` in the post-swap round, one of
  them the page whose six missing subtotal rows the verifier had described in words. That is a
  reporting gap independent of any model choice.
- **`gpt-5.6-luna` on `page` is a live question, not a closed one.** It is 30% cheaper than Kimi,
  ties it on both content kinds, and is declined on an accessibility count of 10-vs-7 across 11
  pages. Settling it needs a corpus with charts and images — which is also the corpus that would
  make the specialist and `builder` rows mean anything.
- **Re-derive the failed-spend figure after #300.** It is the one number here that is known wrong
  rather than merely old.
- **`copy_editor` is 33.1% unswapped, 28.8% after the `page` swap, and its own swap is now
  recommended and undecided.** Two rounds have run — `runs-editor-1` and `runs-editor-2` — and the
  second says `openai.gpt-5.6-luna` at 9.5% of the cost is ahead on capability and on obedience to
  the issue list both (§4), worth ≈−26.1% of the priced bill — §5's four agents, so ≈−25.9% of the
  round including `builder`. Applying it is a decision, not a finding, and it needs the
  same three checks the `page` swap needed: `per_agent` for this agent only, a diff of the
  deployment's whole `providers` block (#312's one line moved every agent's transport), and the model
  id verified against the deployment's IAM allowlist **with the identity that will make the call**.
  One free check first: the deployed editor's cache-read share, since Luna gets no cache discount
  and the −26.1% is measured on a bench arm. Its output ceiling is also still 3.4% from binding (§5).
- **`feedback` is 15.6% and its decision is open, but the round that would settle it is not a
  verifier round.** Neither answer is defensible from what has been measured: the incumbent's lead is
  one class (table figures, 12/14 against 9/14) and the cheap finalist's extra rejections turned out to
  be mostly real defects (§4). What is missing is the *action* cost — #288's 26% clear rate means a
  more accurate verifier at an 84% rejection rate mostly buys corrections that do not clear, and on a
  one-round deployment ships the flags instead. Two free things come first: adjudicate the remaining 33
  control pages, and fix the incumbent's self-retracting `problems` with a prompt clause. The paid
  round worth running instead is against the `page` agent — 12 of 12 disputed pages carry extraction
  defects the verifier is passing, plus #333.
- **A swap invalidates the quality baseline, not just the cost.** `/v1/quality` reports a clean
  rate and mean rounds per document from the judge's verdicts, and a change to `page` or `reader`
  changes what the judge is reading. Re-measure the week after, not the day after.

## 9. Re-running any of it

The rounds live in the benchmark repo (`equalify-iris-bench`), which drives this API rather than
importing Iris. Reading a captured round back costs nothing:

```bash
node --env-file=.env extractround.mjs runs-extract-ad3e7a6 --dry   # §2's page table, free
node src/report.mjs --runs runs-bystep-now                         # §0's cost shares, free
node mixedcost.mjs     runs-postswap-312                           # §5's per-agent prices, free
node verifierdelta.mjs runs-bystep-now runs-postswap-312           # §5's quality deltas, free
node subtotalrows.mjs  runs-bystep-now runs-postswap-312           # the subtotal-row finding, free
node editorround.mjs   --report runs-editor-2                     # §4's editor table, free
node verifyregrade.mjs runs-verifier-1                            # §4's 11-page verifier table, free
node verifyregrade.mjs runs-digits-45                             # §4's 45-page detection split, free
```

`mixedcost.mjs` exists because `report.mjs` prices a whole document at its `primaryModel`, which was
safe for exactly as long as one model served every agent. After a per-agent swap it charges the
incumbent's `feedback`, `reader` and `copy_editor` tokens at the cheap model's rate — it printed
**−78.3%** for the round §5 reports at −44.8%. Anything that prices a mixed-model round has to price
each agent at the model `by_agent[].models` records for it, and refuse rather than guess when that is
unknown.

`report.mjs` regenerates that directory's `summary.json` and `results.jsonl` from the per-chunk
records it keeps. The figures come back identical, but the two files' timestamps do not — so read
a round's date off its `ledger.jsonl` (or the chunk directories), never off the summary.

A single arm of the page round is about $0.20 with `--probe`, and a one-page probe against a
deployment costs more *per page* than a hundred-page round does — $0.2060 for the single cold page of
`runs-probe-swap312` against `runs-bystep-now`'s $0.1940 — so a probe price is a ceiling, never a
quote. A full 100-page round is **$19.40 unswapped, $10.71
swapped**. Every round directory carries `records.jsonl` with the per-row model, sha, token counts and
price, and the raw model replies are in its `logs/` — which is what makes a paid round regradable
for free, and what every number above was re-derived from.
