# Equalify Iris — which model runs which agent

Iris dispatches five agents plus any specialist a page names, and a deployment can point each
one at a different provider and model with one line of `providers.per_agent` (PRD §10.3,
`config.example.yaml`). This document is the answer to "which line should I write, and what does
it cost" — the outcome of the model-selection sprint tracked in
[#246](https://github.com/EqualifyEverything/equalify-iris/issues/246) and reported in
[#311](https://github.com/EqualifyEverything/equalify-iris/issues/311).

Two of the five agents had a cheaper model worth putting on them. **One was applied and one was
declined, and the two were never the same kind of decision.**

- **`page` is swapped and live.** `moonshotai.kimi-k2.5` has served the reference deployment's page
  agent since 2026-09-02
  ([#312](https://github.com/EqualifyEverything/equalify-iris/issues/312)). On 11 hard pages it
  measured at-or-better on cost, word recall, first-pass rate and three of the judge's four defect
  kinds (§2). On **100 pages of the live deployment** it measures **−44.8% of the whole model bill**
  and a content loss the small round could not see: Iris's own unchanged verifier reports
  `content_missing` on **42 pages against the incumbent's 15**, and the specific thing missing is
  the regional subtotal rows of statistical tables
  ([#324](https://github.com/EqualifyEverything/equalify-iris/issues/324), §5). Whether that trade
  is acceptable is a judgement about what a deployment is for; it is not settled here.
- **`reader` was declined.** It was the cheapest defensible cut on paper — 78% of the incumbent's
  own agreement floor for 77% less money — and the decision went the other way once the loss was
  broken out by kind
  ([#313](https://github.com/EqualifyEverything/equalify-iris/issues/313), §3).

Read §2 and §3 before revisiting either. Two agents were left alone for a measured reason worth
reading before benchmarking them again, and one has never been measured at all — for a reason that
is also worth knowing (§4).

**Every figure here names the benchmark round it came from**, because some of them are stale by
design and several are superseded outright — §6 says which. `config.example.yaml` serves every
capability with `us.anthropic.claude-sonnet-4-6`, and **"the incumbent" below means that
unswapped baseline** — not the reference deployment as it stands today, whose `page` agent has run
on `moonshotai.kimi-k2.5` since 2026-09-02.

## 0. The short version

| agent | share of the bill, unswapped | status |
|---|---|---|
| `page` | **42.0%** | **swapped and live since 2026-09-02** (#312) — −44.8% of the whole bill measured on 100 pages, at a named content cost: `content_missing` on 42 pages against 15 (§5) |
| `copy_editor` | **33.1%** | keep. The wins here were code, not a model — and it is now the largest line that has never had a model round (§8) |
| `feedback` | 15.6% | keep. It is the oracle every other number is scored against |
| `reader` | 9.3% | **declined** (#313) — 78% of the incumbent's own agreement floor at −77%, and §3 says what the 22% is |
| `builder` | 0% | 0 in this round, **not zero any more**: it ran twice on the swapped deployment, at about $0.04 a call (§4) |
| specialists | 0% | still 0 calls, and §4 says why that is a fact about `agents_dir` rather than about the corpus |

Shares are of **$19.3951 for 100 pages ($0.1940/page), `runs-bystep-now` at `3749f54`** — the
unswapped deployment, so they are the shares the two decisions above were taken against. They
partition that round's priced spend and sum to 100.0%. They are **shares, not prices**, and the
swap has since moved them: §5 has the post-swap partition, in which no agent is above 29%.

**"78% of the incumbent's own agreement floor" is a ratio of two agreement rates, not a miss rate.**
Kimi reproduces 118 of 180 reference findings (65.6%) and the incumbent's own second pass reproduces
152 (84.4%); 65.6 ÷ 84.4 = 78%. Read bare, that sounds like losing a fifth of the issues; the
absolute per-issue miss is **34%**. §3 gives the paired figure, which is the one that charges a swap
for its own losses rather than for the reference's irreproducibility.

The applied swap is one line:

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
$0.0216/doc, −77%, one config line and nothing else. The table above is the case for it. Here is
what settled it against, and none of it needed another round — the loss was broken out by kind from
the rounds already on disk:

| | reproduces the 180-finding reference | findings lost | $/doc |
|---|---|---|---|
| incumbent ×1 — the reference | — | — | $0.0938 |
| **incumbent ×1 again — the control** | 152/180 = 84.4% | 26 (14.4%) | $0.0924 |
| **kimi ×1** | 118/180 = 65.6% | 55 (30.6%) | $0.0216 |
| kimi ×2 | 135/180 = 75.0% | 42 (23.3%) | $0.0415 |

**The swap's own cost is the paired figure: 34 findings — 18.9% of the reference — that Kimi loses
and the incumbent's own repeat keeps.** Not "a fifth of the issues", and not 55 − 26 either: the
control's losses are not a subset of the arm's, so two counts over one denominator do not subtract
into a paired count. Of the 34, **7 are high severity**, and reading those 7 rather than counting
them is what decided it — an empty `<h1>`, link text broken mid-word so the accessible name is a
word fragment, pages of body text with no headings, and **three findings of data tables emitted as
absolutely-positioned paragraphs with no table element, no headers and no caption**. That last kind
is exactly what the editor and `tables.ts` exist to act on, so it is not a cosmetic loss.

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

## 4. The three keeps

**`copy_editor` (33.1%) — keep.** Every win on this agent this sprint came from changing what it
is asked to do, not who does it: table joins moved into code
([#278](https://github.com/EqualifyEverything/equalify-iris/issues/278) — 62% of split tables
joined at $0, 0 refused by Iris's own `verifyJoin`, with the measured caveat that the code path
keeps the first half's header and one joined document read "19592"); the editor patches blocks
instead of retyping the document (#277, #258 — 22%, after the finding that 44% of documents could
not fit the reply at all); and a truncated reply's completed blocks are now applied instead of
thrown away (#300). No cheaper editor has been benched as *better*, and this agent's share is
larger than the sprint's own report had it, so it is the obvious next place to look — see §8.

**`feedback` (15.6%) — keep, and treat a swap here as a change to the instrument.** This is the
judge behind every quality number in this document, in `/v1/quality`, and in Iris's own review
loop. Its rejections are mostly real: of 33 rejections of *undamaged* control documents, 26 were
genuine contract violations, two of which have since been fixed in Iris. A cheaper judge does not
just cost less — it moves every measurement, including the ones used to justify the two swaps
above.

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

| agent | unswapped | swapped | | share after |
|---|---|---|---|---|
| `page` | $8.1521 (158 calls) | **$2.6098** (165) | **−68.0%** | 24.4% |
| `copy_editor` | $6.4118 (28) | **$3.0849** (15) | **−51.9%** | 28.8% |
| `feedback` | $3.0226 (95) | $2.6125 (94) | −13.6% | 24.4% |
| `reader` | $1.8086 (33) | **$2.4034** (40) | **+32.9%** | 22.4% |
| total | $19.3951 | **$10.7106** | −44.8% | 100.0% |

**Only about a third of the saving comes from the agent that was swapped**, and the projection this
section used to carry (−25%, and described as a *floor* that the lost prompt cache could only push
up) was wrong in the generous direction for a reason worth keeping: **a one-agent swap re-prices
every agent downstream of it.** Kimi's markup is leaner, so the editor's job got smaller — 28 calls
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
| $0.1071/page, −44.8%, the quality deltas | `runs-postswap-312` | the live swapped deployment | **yes** — one round per arm, §5 says what that does and does not support |
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

## 7. Five limits worth knowing before re-benchmarking

- **There is a ceiling and it is about 84%.** The incumbent reader agrees with its own previous
  pass on 84–85% of issues. Every "% of floor" number is against that, not against truth. A raw
  agreement figure quoted without the floor beside it overstates the gap between models.
- **Every share needs its denominator.** 42.0% is of $19.3951 at `3749f54`. −44.8% is of the whole
  bill; −56% and −68.0% are of the page agent's own spend. 78% is of an 84% floor, and 18.9% is of a
  180-finding reference. 10.89% was of $176.53 across 63 rounds. Those are five different
  denominators, and mixing them was the most common way a number went wrong in this sprint.
- **A share is a ratio, so it moves when any other term moves.** Predicting one agent's share from
  the commits that touched *that agent* is the mistake §6 records: `page`'s share fell while its own
  cost was untouched, because `copy_editor`'s rose.
- **The oracle is a lower bound, and it is the incumbent.** A flag on a page a human would pass is
  a cost, not an error; the judge was never scored against itself.
- **The corpora are small and named.** Page agent: 11 hand-picked hard pages (dense budget tables,
  dot-leader contents, statutory prose, two pure scans). Reader: 20 stitched documents. Cost shares
  and the −44.8%: one 100-page US government statistical report — hierarchical tables of states
  grouped into regions, and at least one choropleth map (§4). Nothing here is a claim about arbitrary
  PDFs, and §5's content finding is on the hardest possible corpus for exactly that failure mode.

## 8. What would change these answers

- **Whether the applied `page` swap stays is the open question, and it is not a cost question.**
  −44.8% of the bill against the regional subtotal rows of a statistical report (§5). The revert is
  the one config line that applied it. Two things would settle it better than another price round: a
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
- **`copy_editor` is 33.1% unswapped, 28.8% after the swap, and has never had a model round.** It is
  the largest unexamined line on the bill, and its output ceiling is 3.4% away from binding again
  (§5) — the three merged wins were all changes to its contract rather than to its model.
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
deployment costs more *per page* than a hundred-page round does — $0.2060 against $0.1940 — so a
probe price is a ceiling, never a quote. A full 100-page round is **$19.40 unswapped, $10.71
swapped**. Every round directory carries `records.jsonl` with the per-row model, sha, token counts and
price, and the raw model replies are in its `logs/` — which is what makes a paid round regradable
for free, and what every number above was re-derived from.
