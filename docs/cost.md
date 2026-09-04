# What Iris costs, and the recommended approach for every step

Iris cost about **19.4 cents a document page** in model bills when the model-selection sprint
([#246](https://github.com/EqualifyEverything/equalify-iris/issues/246)) started. One config change
has shipped and measured **10.7 cents** — a 45% cut with no code change, from **two lines of
config** (#312 set the page agent's model *and* a block-wide API setting; §8). Two more
recommendations are measured and waiting on a person to take them.

**The most useful thing the sprint found is that three of the four biggest savings were not model
choices at all** — they were a code path, a contract, and not paying twice for the same reply — and
**the three largest remaining levers are also not model choices.** They are: writing down rules the
page prompt leaves unstated ([#369](https://github.com/EqualifyEverything/equalify-iris/issues/369)),
one specific defect that is the second-largest cause of Iris's second-pass bill
([#324](https://github.com/EqualifyEverything/equalify-iris/issues/324)), and the fact that two
agents bill for working-out that Iris throws away
([#365](https://github.com/EqualifyEverything/equalify-iris/issues/365)). Competitors sit near **2
cents**, so this closes a large part of the gap and does not close it.

This document is the sprint's answer **per pipeline step**, which is not the same question as *which
model to put on which agent*. That one — every agent's call sites, the ways a `per_agent` edit fails
silently, and the older rounds in full — is **[docs/models.md](models.md)**. Where the two disagree,
this one is measured on a later round and says which; §7 lists the specific claims it supersedes.
Every figure below names the round it came from, and no figure is carried from a different run than
the one beside it.

Rewritten from the sprint's final report,
[#370](https://github.com/EqualifyEverything/equalify-iris/issues/370). **§6 records the seven
figures this document states differently from that report, and why** — none of the seven moves a
recommendation, and naming them is cheaper than a reader finding them.

## 1. The recommendation, per step

| step | share of bill | recommendation | measured on | disposition |
|---|---|---|---|---|
| **`page`** (extract) | 42.0% | **switch `kimi-k2.5` → `gpt-5.6-luna` — on cost and lost pages, not on quality** | #344: **−15.9% per 100 pages** ($6.1201 → $5.1496) and **0 lost pages against 2**. First-pass acceptance is a wash: 29.7% against 26.7%, paired **McNemar p=0.6636** | open, needs a person (#344) |
| **`correct`** + **`feedback`** (2nd pass and the checker that triggers it) | **62–85% of the extraction step, together** | **no model change. Three code-and-prompt fixes instead** | #369 (writing the missing rules down removes ~1/7 of it); #324 (one defect ranks 2nd of 22 causes); #365 (69% of the checker's output is discarded and billed) | model settled; open #369, #324, #365 |
| **`copy_editor`** | 33.1% | **switch → `gpt-5.6-luna`, −26.1%** | **`runs-editor-2` only** — 21 of 23 provable defect instances against 12, at 9.5% of the cost. `runs-editor-1` ranked the same two the *other* way and is superseded: it withheld the page images Iris attaches, so it measured a different agent | #329 closed **unapplied**, needs a person |
| **`reader`** | 9.3% | **keep the incumbent.** The prompt fix already shipped | #303 shipped (−19%, the largest proportional per-step drop of the sprint); the Kimi swap loses **34 findings the incumbent's own repeat keeps, 7 of them high severity** | #313, declined — correctly |
| **`table_join`** | $0.72–1.67 / 100 pages | **keep Iris's free code path; fix its instability** | #326: the same code joined 9 of 17 pairs one round and 4 the next, a $0.72/100-page swing with the join code byte-identical | open (#326) |
| **`builder`** + **`specialist`** | ~0.0% | nothing to bench on this corpus | a **structural** zero, not a corpus one: resolution is by file stem in `agents_dir` and `chartDataAgent` is the only specialist shipped, so a page asking for `mapChart` finds nothing to call. `specialist_merge` has never fired and cannot until a specialist file is merged | asserted in Iris |

The share column is **not a partition and does not sum to 100%**: the first four are shares of the
un-swapped whole-pipeline bill (`runs-bystep-now` at `3749f54`, docs/models.md §0), `correct` and
`feedback` are a share of one step measured on a different round, and `table_join` is a dollar range
because it is a code path with no model bill of its own. Mixing those denominators was the most
common way a number went wrong in this sprint, so they are labelled rather than blended.

**Two decisions need a person: #344 and #329.** Both are measured; neither is an agent's to apply.
**#324 is a third, and it is live in production right now**, which makes it the urgent one.

## 2. The page step is one decision across two issues

[#324](https://github.com/EqualifyEverything/equalify-iris/issues/324) (is the shipped swap worse
than what it replaced?) and
[#344](https://github.com/EqualifyEverything/equalify-iris/issues/344) (is there a better model
still?) are two sides of one question — **which model reads a page** — and they point different ways
on different axes. Rather than merge them, here is every axis at once, on one round with one pinned
checker:

| axis | best | middle | worst |
|---|---|---|---|
| $/100 pages | **luna $5.1496** | kimi $6.1201 | sonnet $12.5991 |
| pages lost outright | **luna 0 and sonnet 0** † | — | kimi 2 |
| first-pass acceptance | sonnet 41.1% | luna 29.7% | kimi 26.7% (luna against kimi, p=0.6636) |
| region subtotal rows dropped | **sonnet 9.6%** | luna 23.3% | **kimi 34.9%** |
| mechanical defect census, **10 axes** | **luna best-or-tied on 8 of 10** | sonnet | kimi worst on 4 of the first 7 |
| "no data" dot-leader encodings | sonnet | kimi | **luna worst** |

The census row is the count of every axis the sprint scored by script from the delivered HTML, and
**the two rows around it are two of the ten** — the subtotal-row axis is one of the two luna does not
win, and the dot-leader axis is the other. They are broken out because they are the two that cost
something, not because they sit outside the count. The ten are the seven clause-anchored axes of #334
and #333, the `<abbr>` fabrication axis of #335, the dot-leader axis of #374, and the subtotal-row
axis of #324.

**† The lost-page column was corrected on 2026-09-03 and the correction goes against the
recommendation.** Sonnet had been published at 1 lost page. Re-reading the round's logs after
`05d5982` landed, sonnet's one `page_extraction_failed` is `acir-p049`, where its own log shows the
page agent returning a **complete** envelope; what failed was the checker, whose reply overran the
32,000-token ceiling at 93,072 characters, and the provider error propagated into `failedPage` and
was logged as an extraction failure. That is
[#368](https://github.com/EqualifyEverything/equalify-iris/issues/368), fixed on main in `05d5982`,
which names this same page. **Corrected: kimi 2, sonnet 0, luna 0** — so on this axis the arm not
recommended is tied with the one that is, and the shipped model is alone in the column. Both of
kimi's survive the re-read as genuine page-agent failures (`acir-p050`, `acir-p086`). The same
correction reclassifies sonnet's $0.5091 of failed spend from page-agent waste to **pinned-checker**
waste, which is #365's finding arriving from the other direction.

**The recommendation is `gpt-5.6-luna`.** It is the cheapest, it is one of the two arms that lose no
pages, and it is best-or-tied on eight of the ten mechanically counted defect axes — **not on all of
them**, which is how #370 puts it and is the seventh figure §6 restates.

**What that recommendation costs, stated plainly.** On the subtotal-row axis — the one that drives
the most correction spend — luna is **2.43x worse** than the model Iris ran before this sprint
(23.3% against 9.6%), and on the dot-leader axis it is the worst of the three. **On first-pass
acceptance the price ranking and the quality ranking are opposites**, and the dearest arm is the
best.

**A revert to sonnet buys 34.9% → 9.6% on the subtotal rows, not → 0**, and the price of the revert
depends on which arm you are reverting *from*, which is worth stating because the two multiples
differ by a fifth:

| revert | subtotal rows dropped | extraction bill |
|---|---|---|
| from the shipped `kimi-k2.5` | 34.9% → 9.6% | **2.06x** ($6.1201 → $12.5991) |
| from the recommended `gpt-5.6-luna` | 23.3% → 9.6% | **2.45x** ($5.1496 → $12.5991) |

**No model gets the subtotal rows right, which is the sprint's own headline arriving at the page
step: the durable fix is the free artifact check in #324, not a model choice.** A region subtotal row
with no digits beside state rows that have them is decidable from the delivered HTML with no model
call and no image.

## 3. What it costs, and the denominator each figure uses

Final round: **`runs-extract100-95ca64c`** — iris `95ca64c`, `agents/page.md c666a6975261`,
`agents/feedback.md 883480a36cd0`, **checker pinned to `claude-sonnet-4-6` on every arm by design**,
so a page-only swap is priced with verification still at incumbent rates. All three arms closed at
**0.0% ledger drift** against the round's own `records.jsonl`.

| page model | $/100 pages submitted | verify + correct | its share | first pass accepted | pages lost | page only, no checker |
|---|---|---|---|---|---|---|
| `claude-sonnet-4-6` | **$12.5991** | $7.7925 | 62% | 37/90 = **41.1%** | **0** † | $4.8066 |
| `kimi-k2.5` (shipped) | **$6.1201** | $4.5953 | 75% | 24/90 = **26.7%** | **2** | $1.5249 |
| `gpt-5.6-luna` (recommended) | **$5.1496** | $4.3772 | **85%** | 27/91 = **29.7%** | **0** | $0.7724 |

**`verify + correct` is one column for two steps and the round does not split it.** It is the
checker's calls plus the correction passes they trigger, and that is why §1 gives `correct` and
`feedback` a single 62–85% row rather than a share each — a share each would double-count this
column. The split exists in principle (docs/models.md §4 prices a verify call at $0.0296 and a
correction pass at $0.0619 on the sonnet arm) but not in this round's published table.

**Two denominators, named rather than blended.** Divided by *pages submitted* — 100, identical across
arms — those totals are **$0.1260, $0.0612 and $0.0515** a page. Divided by *pages that produced an
HTML file* they are $0.1385, $0.0665 and $0.0566, and **that second denominator is not comparable
across arms**: an accepted blank page writes no file while a failed page writes a 77-byte
`@page-failed` comment, **so the worse arm gets the larger denominator**. Every cross-arm figure in
this document uses pages **submitted**.

**Whole pipeline:** $0.1940/page un-swapped → **$0.1071/page** measured with the page swap live
(#324, and docs/models.md §5, `runs-bystep-now` at `3749f54` against `runs-postswap-312` at
`2566c8b`). **Extraction and its check are about half of that** — the two agents come to $0.0522 a
page inside `runs-postswap-312` itself (`page` $2.6098 + `feedback` $2.6125 over 100 pages), against
$0.0612 for the same model in `runs-extract100-95ca64c`. Half is the honest statement; the two rounds
are a prompt generation apart, so a single percentage carried across them is a cross-round ratio
(§6).

**Against the target.** #246 set it at ~$0.02/page. The measured $0.1071 is **5.4x** that, so the
remaining gap is not a model-selection problem — which is the most useful thing the sprint
established. What changed is where the gap lives: after the shipped swap there is no single dominant
agent left to swap, so the next win comes from asking an agent to do less.

### The third arm closed, and the part promised either way reversed

The first version of the final report published the luna arm at 46 of 100 pages, with a commitment to
post it closed **including if it reversed**. It closed, and it did:

> **`gpt-5.6-luna` against `kimi-k2.5`, paired on the 90 pages both treated as content:** both clean
> 15, only kimi 9, only luna 12, neither 54. Clean rate 26.7% against 30.0%. **McNemar exact
> two-sided p = 0.6636.**

**Twelve discordant pages one way, nine the other — a coin flip.** That is the statistic #344 was
filed on at **p=0.0075**, one prompt generation earlier. The clean rate reads 30.0% here and 29.7% in
the table above because the paired test is over the 90 pages *both* arms treated as content and the
table is over the 91 luna produced.

**What did not reverse: cost and lost pages.** Cost is token spend and reproduces to four decimal
places across both prompt generations, and a lost page is counted at the page agent before the
checker is ever called. Those are the two things the recommendation now rests on, and they are the
least checker-dependent numbers in the round.

### Why the two open savings are not multiplied together

#344 is −15.9% on the extraction step. #329 is −26.1% on the copy editor. **Composing those into one
projected $/page would repeat the sprint's most-quoted correction.** The shipped page swap was
projected at −23.6% and measured **−44.8%**, because the projection priced the swapped agent and not
the pipeline: kimi's leaner markup also removed both copy-editor output-ceiling truncations (28 → 15
calls) and moved `feedback` and `reader` too, and the round even **grew** an agent it had not had
before (`builder`, from two auto-filed suggestions). **Three of the four per-agent moves were not the
swapped agent.** The sign of that spillover is not predictable from one agent's row, so each saving
is measured on its own arm and the combination is worth measuring after whichever lands first.

## 4. The alternative was often not a cheaper model

This is the finding worth carrying forward above any model pick. Ranked by what they actually saved:

- **A code path, not a model.** The table-continuation join written in plain code, made to **decline**
  rather than guess any case needing judgement, and scored with `verifyJoin` imported unmodified from
  `src/pipeline/tables.ts` — the same gate the model's answer had to clear. On **50 pairs drawn from
  three prior rounds**, for **$0**: **62% joined and accepted, 0 refused.** Whatever the model was
  buying on the mechanical part, it was not buying acceptance. Read the declines and 7 of 17 were
  Iris's own page agent transcribing one printed header two ways — **an extraction bug wearing
  another step's costume** (#326).
- **A contract, not a model** (#258, #277): numbered-block edits instead of a whole-document reply.
- **Not paying for the same reply twice** (#297, #300).
- **A prompt, not a model** (#303): −19% off the Reader, the largest proportional per-step drop of
  any single change — and the precedent behind #365, because that same clause took prose from 40% to
  0% and output tokens down 29%.
- **A free artifact check, not a model** (#324, #333, #345): a region subtotal row with no digits
  beside state rows that have them; a page marker whose label tracks its file position; an ARIA role
  that does not exist. **All three are decidable from the delivered HTML with no model call and no
  image**, and on all three every model in the bench fails.

**OCR and no-model extraction were measured and are not recommended.** `nomodel.pdftohtml`,
`nomodel.pdftotext-paragraphs` and three Textract variants all ran the full corpus (`runs-ocr`,
`runs-ocr-asserted`, `runs-ocr-inferred`). They are on the ladder for completeness, not as
candidates.

## 5. Where another round would still change the answer

Three places, out of a sprint asked to loop until another round would not.

1. **The checker's price is the biggest un-taken decision, and it has two independent handles.** After
   the recommended swap, **85% of the extraction step is checking and correcting** — a floor no
   cheaper page model gets under.
   - **The model.** Cheaper checkers are priced and their detection rates measured on
     `runs-verifier-1` (645 calls): luna 84%, Haiku 4.5 64%, Qwen3-VL 56%, Nova-2-Lite 24%. Swapping
     to luna prices at **−47.9%** of the step with luna writing the pages. **It is not recommended**,
     and the reason is sharper than "84% detection means 16% ships": the challenger also rejects
     **undamaged control pages** at a rate in the same range, and **an undamaged page is not a
     verified-correct page, so that is not a false-positive rate.** Two rounds measure it and they are
     not the same measurement — `runs-verifier-1` rejects **26 of 33** control pages with **2**
     adjudicated, and `runs-digits-45` rejects **84.4%** of 135 control draws, a figure docs/models.md
     §4 also has published as 85.2% one call apart. models.md §4 then adjudicates all **12** pages of
     that round where the two arms disagree completely and finds a real defect the incumbent passed on
     every one — which is why the number cannot carry a decision in either direction. **An adjudicated
     control set is the single most valuable round left**, and it is the one thing here that would
     settle the checker.
   - **The volume** ([#365](https://github.com/EqualifyEverything/equalify-iris/issues/365)). 69% of
     the checker's reply characters fall outside the JSON envelope Iris parses — **$1.99 per 100 pages
     of billed, discarded text** — and the corrector does the same, once expensively enough to
     truncate a page mid-repair and ship nine problems unfixed at 7.1x the round's average page cost.
     The clause that took the Reader from 40% prose to 0% **is already in the checker's prompt** and
     does not bind; §3 of #365 has the three structural differences. This is the cheapest of the
     three levers and it does not require choosing a model.
2. **The corpus has no charts and no scores.** It is a 1962 US intergovernmental-finance report. That
   is why `specialist` and `builder` are near zero, and why the accessibility comparison rested on 8
   map plates rather than a chart corpus (#372). **A prose-heavy corpus is the higher-value of the two
   rounds not yet spent**, because #324's whole finding is about hierarchical statistical tables, and
   that round answers the question a deployment is actually asking: *does this defect ever fire on the
   documents we get?*
3. **The quality detectors have a measured noise floor and it is not small.** Repeat runs on identical
   inputs disagree on **8 and 19 pages of 100**. It was measured rather than assumed, and it swamped
   several effects that had already been published. Every quality claim resting on a single round is
   flagged in its own issue.

## 6. Seven figures this document states differently from #370

Named rather than quietly changed, because #370 is the source and a reader may have the report open
beside this. None of the seven moves a recommendation, and each is checkable against the round it
names without spending anything (§10).

- **The revert price multiple.** #370 reads "34.9% → 9.6% at 2.4x the price". 34.9% is the *shipped*
  kimi arm's subtotal-row rate and 2.4x is the *recommended* luna arm's price ratio against sonnet.
  §2 gives both pairings: 2.06x from kimi, 2.45x from luna.
- **Luna's page-only spend is $0.7724, not $0.7641.** Both appear in #370 — $0.7724 in the body's
  table, $0.7641 in a thread comment. $0.7724 is the one that reconciles: $5.1496 − $4.3772 =
  $0.7724, and the report's own instruction is to read the body rather than the thread.
- **"Extraction is 57% of the pipeline" is a cross-round ratio.** Its numerator ($0.0612) is
  `runs-extract100-95ca64c` and its denominator ($0.1071) is `runs-postswap-312`, a prompt generation
  apart. §3 states it as about half and shows the same two agents at $0.0522 a page *inside* the
  later round.
- **`correct` and `feedback` share one measured column, so they get one row.** #370's §1 gives
  `correct` 62–85% of extraction and `feedback` 75–85% of extraction; both are the same
  `verify + correct` column of the same table, so stated as two rows they double-count it.
- **The `copy_editor` swap rests on `runs-editor-2` alone.** #370's §1 names `runs-editor-1` beside
  it, and that round **ranked the same two models the other way** — it sent the editor the document
  and the issue list but not the page images Iris attaches, and docs/models.md §6 carries it as
  superseded for exactly that reason. Citing it as corroboration would be citing the result that was
  overturned. §1 names it as the superseded round instead.
- **The checker's control-rejection rate is two rounds, not one.** #370's §4 reads "that 84.4% is the
  rate at which the challenger rejects undamaged control pages — 26 of 33 were rejected and only 2
  adjudicated", which reads as one measurement. 84.4% is `runs-digits-45` over 135 control draws; 26
  of 33 is `runs-verifier-1` over pages, and 26/33 is 78.8%. §5 states both with their rounds. Neither
  is wrong and the conclusion is unchanged; a reader who tried to reconcile them would find they do
  not.
- **"Best-or-tied on all eight mechanical defect axes" is best-or-tied on eight of ten.** #370's §2
  drops the denominator from the sentence its own source wrote: "across the nine mechanical axes I
  have now counted, luna is best-or-tied on eight" (#344), where the ninth is the dot-leader axis on
  which luna is the **worst** of the three. A tenth axis — dropped region subtotal rows — was counted
  after that sentence, and luna is not best on it either. "All eight" deletes the counter-case, and
  the counter-case is the reason this recommendation is stated as cost-and-robustness only rather
  than as a clean win. §2 gives it as 8 of 10 and names all ten.

Two citations are tightened rather than corrected. The checker tie of **40/45 against 39/45** is
`runs-digits-45` (360 calls), while the 645-call figure belongs to `runs-verifier-1`, which is where
the detection ladder in §5 comes from. And the reversed paired test is over **90** pages, not the 91
#370's §5 gives it — 90 is the count both arms treated as content, which is what a paired test is
over, and 91 is luna's own denominator in the table above.

## 7. What this supersedes in docs/models.md

That document is per-agent, older, and still the right place for call sites, the ways a `per_agent`
edit fails, and every round before `runs-extract100-95ca64c`. Three of its claims are narrowed here
and one open question in it is answered:

- **`page` is swapped and live on `kimi-k2.5`, and the recommendation is now to move again**, to
  `gpt-5.6-luna`, on cost and lost pages (§2). models.md §8 carries luna on `page` as "a live
  question" needing a corpus with charts; on the corpus that exists it has now been measured at 100
  pages, and what is still unmeasured is the chart case, not the price.
- **models.md §2's 11-page page-agent table is not a quality result**, which it says of itself; §2
  and §3 here are the 100-page rounds that superseded it.
- **`feedback` is carried as `open` there and as "keep the model" here, and both mean do not swap
  now.** The cost case is settled in the direction of the swap under both correctors measured; what
  is unmeasured is verdict quality, and nothing in this sprint bounded it. §5 says what would.
- **`copy_editor`'s −26.1% is unchanged** and still unapplied (#329). What is added is a cache
  figure: **cache reads are 0.66% of billed input on that agent**, so the prompt cache is not a term
  in the comparison. That is the free check models.md §4 left outstanding — "if the incumbent is
  cache-heavy there, its real $/doc is under $0.1172 and −26.1% is optimistic" — **on the condition
  that 0.66% is the incumbent's share and not the challenger's**, which #370 does not say. Read it
  as the check having been run and needing one word of attribution before it closes the question.

## 8. Open handoffs

**Needing a person's decision, in order of urgency:**

- **#324** — the shipped page swap is live and priced: −44.8% of the bill against region subtotal rows
  dropped from statistical tables. A revert is **two** config lines, not one (#312 set
  `providers.per_agent.page` *and* `providers.bedrock.api: converse`, which is block-wide), and it
  buys 34.9% → 9.6%, not → 0.
- **#344** — swap the page agent to `gpt-5.6-luna`, on cost and lost pages.
- **#329** — closed, but its copy-editor swap is unapplied.

**The three largest levers, all prompt or code rather than model spend:** #369, #324's free check,
#365.

| open issue | what it needs |
|---|---|
| **#365** | a no-prose clause positioned like #303's, on the checker and the corrector |
| **#369** | the missing page rules written down; ~1/7 of the second-pass bill |
| **#373** | let the corrector decline a problem it can prove false, and log it |
| **#374** | printed conventions `page.md` leaves unspecified, so every model invents one |
| **#371** | ask for `blank` as a field instead of parsing an English sentence for it |
| **#372** | the 8 map plates; three failure modes, one accidental guard |
| **#334** | two zero-risk code repairs on page output |
| **#333** | the page marker is checkable in code with no model call |
| **#345** | one clause, plus an invalid-role guard in `roles.ts` |
| **#356** | one live axis, and it should ship as a report rather than a refusal |
| **#326** | log the two header signatures on a join decline; read declines as a stability canary |
| **#317** | measured and answered; waiting on a corpus that truncates |

**Rounds available on request, priced:** a prose-heavy 100-page corpus (~$10.70) to answer whether
#324's defect fires on real documents; an adjudicated control set for the checker swap; a ~$4–5
narration arm for #365; the #319 arbiter on a table-dense corpus; a ~$1.45 three-arm plate round for
#372.

## 9. What the sprint got wrong, since that is the part that transfers

- **An agent was priced and called a pipeline** — projected −23.6%, measured −44.8%. The error was in
  the *generous* direction, which is the harder one to catch.
- **A recommendation was published on p=0.0075 and it re-ran at p=0.6636.** One prompt generation
  apart, same two models, same corpus. The lesson is not that significance is unreliable — it is that
  **a 90-page paired test on one round is a draw, and a headline was filed on one draw.**
- **"Catches 57 of 57, misses nothing" was published from 11 hand-picked pages** and a decision
  recommended on it. At 45 pages it missed 5. **Widen the corpus before publishing the headline, not
  after.**
- **The detectors were biased against the shipped model, twice, the same way.** Two anchored patterns
  keyed on the tag immediately after `<p>`/`<li>`; kimi wraps inline content in `<em>`/`<strong>`; so
  a **0** was published for the shipped model on two axes that were not zero. A detector calibrated
  on one model's output silently under-reports another's, and in a cross-model comparison that bias
  runs in the worst possible direction.
- **A share table that did not sum to 100% and nobody checked it** — four agent shares summing to
  94.6%, because each numerator excluded the agent's own failed spend while each denominator kept it.
  `test/config-agents.test.ts` now checks both of this repo's share tables, and the arithmetic of the
  cost table in §3.
- **Two arms agreeing is not corroboration when they share a mechanism.** On #333, two vendors in two
  different rounds emitted the same wrong page number and agreed exactly. What separated them was a
  structural regularity, not a third vote.
- **Four separate times a free re-read of rounds already paid for inverted a paid conclusion.** That
  is the cheapest instrument there is, and it kept getting reached for second.
- **One method fix worth naming because it nearly cost a round.** Every analysis script was pinned to
  one Iris checkout while the script that *spends the money* still defaulted to a shared checkout
  parked 35 commits behind on an unrelated branch with a different `agents/page.md`. `git worktree
  list` showed nine checkouts carrying **seven distinct `page.md` blobs.** A $0 dry run caught it.
  Provenance is now a `git hash-object` of the bytes the loader reads, rather than a `rev-parse` of
  the committed blob — `e0eb74a` (#360) does the same inside Iris for `agent_sha`.

## 10. Re-deriving any of it

The rounds live in the benchmark repo (`equalify-iris-bench`), which drives this API rather than
importing Iris. Every round persists its raw model replies, so **reading a paid round back costs
nothing** — which is what makes every figure above independently checkable, and it is worth being
exact about what has and has not been checked. **The figures are as the seat that ran the rounds
published them in #370.** What was done here is a re-check of their *internal* consistency — every
decomposition, every share against its own cells, every denominator against the one named beside it —
not a re-derivation from the round records. §6 is what that check found, and it found six things,
which is the honest measure of how much a free arithmetic pass is worth. Re-deriving from the records
is still the stronger check, and these are the commands:

```bash
node src/report.mjs --runs runs-extract100-95ca64c   # §3's three arms, free
node mixedcost.mjs     runs-postswap-312            # the per-agent whole-pipeline prices, free
node verifierdelta.mjs runs-bystep-now runs-postswap-312   # the quality deltas, free
node subtotalrows.mjs  runs-bystep-now runs-postswap-312   # §2's subtotal-row finding, free
node editorround.mjs   --report runs-editor-2       # §1's copy_editor row, free
node verifyregrade.mjs runs-digits-45               # the checker tie, free
```

Two things to check before combining a new round's figure with one above. **The prompt's blob sha**,
not the commit: two rounds ten commits apart have turned out byte-identical across the pipeline
files, and two rounds at the same `iris_sha` have carried different `page.md` bytes. And **the
denominator**: pages submitted, pages that produced a file, and calls are three different counts in
this document's tables, and the tables say which.

`report.mjs` regenerates a round's `summary.json` and `results.jsonl` from the per-chunk records it
keeps. The figures come back identical but the timestamps do not, so read a round's date off its
`ledger.jsonl`, never off the summary.
