# Which model runs which agent

Iris dispatches five agents, plus any specialist a page asks for. A deployment points each one at a
provider and model with one line of `providers.per_agent` (see
[config.example.yaml](../config.example.yaml)). This document says which line to write and what it
was measured at.

**Every model here is a suggestion, not a default.** Iris names no model in its own code —
`resolveAgentModel` (`src/providers/index.ts`) reads your config and nothing else, and an
unconfigured provider throws rather than falling back to something. An agent with no `per_agent`
model gets its provider block's `default_model`.

**The suggested setup is the paid end of a range that starts at zero.** Point
`providers.openrouter.base_url` at a self-hosted open-weight model and Iris costs nothing per token.
No round below measures that path, so nothing here says what it produces.
[docs/cost.md](cost.md) prices both ends.

A **round** in this document is one captured run of a fixed corpus, named like
`runs-extract100-95ca64c` — not a round of the reader/editor loop
([README § Terms](../README.md#terms)).

## The suggested config

| agent | what it does | suggested model | status |
|---|---|---|---|
| `page` | reads the page image, writes its HTML, fixes what `verify` rejects | `us.openai.gpt-5.6-luna` | **applied 2026-09-10** (#344) |
| `feedback` | verifies each page: pass, or a list of problems | `claude-sonnet-4-6` | **keep** (#330) |
| `copy_editor` | applies the review; joins a table split across a page break | `claude-sonnet-4-6`, or `openai.gpt-5.6-luna` | **recommended, not applied** (#329) |
| `reader` | reads the assembled document and proposes edits | `claude-sonnet-4-6` | **declined** (#313) |
| `builder`, specialists | drafts a specialist agent for a content type a page asked for | anything | ~$0.04 a call, 2 calls in the whole sprint |

```yaml
providers:
  default: bedrock
  bedrock:
    api: converse # required for any non-Claude id, and it moves EVERY agent on this block
    default_model: us.anthropic.claude-sonnet-4-6
  per_agent:
    page: { provider: bedrock, model: us.openai.gpt-5.6-luna }
```

That block is the reference deployment's. `config.example.yaml` ships `openrouter` as the default
provider instead, where the same models carry different ids (`anthropic/claude-sonnet-4.6`) — so copy
the shape, not the strings.

**The `us.` prefix is part of the id.** `openai.gpt-5.6-luna` is offered only as a cross-region
inference profile, so the bare id cannot be called at all. `moonshotai.kimi-k2.5` was the opposite —
on-demand, called bare. Check before you write it:

```bash
aws bedrock list-foundation-models \
  --query 'modelSummaries[?modelId==`<id>`].inferenceTypesSupported'
```

On AWS there is one gate Iris cannot see: the calling role's IAM policy enumerates invocable model
ARNs, and an inference-profile model needs **both** its `inference-profile/us.<id>` and
`foundation-model/<id>` ARNs. Missing that, the refusal arrives as a runtime error on a user's
upload rather than at boot — which is how #312 shipped broken for a day.

## Four ways a swap fails

1. **A `per_agent` key that names no agent is warned about, not refused.** The call falls through to
   the provider's `default_model` and the document costs what it would have anyway, so **a typo reads
   as "the cheaper model saved nothing."** Boot logs the unroutable key (`perAgentKeyWarning`,
   `src/config.ts`); it warns rather than fails because a specialist's name is just a file in
   `agents_dir`.
2. **A model id belongs to a provider, and nothing checks it belongs to yours.** An override with
   only `model:` keeps `providers.default`. A Bedrock id under an OpenRouter default fails on every
   call of the run. Name `provider:` as well as `model:`, always.
3. **`copy_editor` is one key for two jobs** — the review pass and the table merge — so they cannot
   be put on different models.
4. **`api: converse` is block-wide.** Setting it for one non-Claude model moves every agent on that
   provider onto a transport no round may have measured.

**How to tell whether the swap took.** Diagnostics reports the model ids that answered each agent's
calls: `by_agent.<agent>.models` from `GET /v1/sessions/{id}/diagnostics`
([API.md](API.md#diagnostics-timing--hang-detection)). Read it on a session that has only run since
the edit — a session's log spans its feedback rounds too, so one extracted before a restart and given
feedback after it honestly holds both ids. Two ids are not automatically a defect: resolution keys on
capability, so a provider's `per_capability` block can put one agent on two models deliberately.
`/v1/quality` cannot answer this; it carries no per-step breakdown.

## What each suggestion was measured on

Corpus for all of it: 100 pages of one 1962 US government statistical report, dense hierarchical
tables, pure scan, no ground truth ([cost.md § Scope](cost.md#scope)).

**`page` — applied twice, and the second one is what runs.** `us.openai.gpt-5.6-luna` replaced
`moonshotai.kimi-k2.5` on 2026-09-10 (#344), which had replaced Sonnet on 2026-09-02 (#312). luna's
case is cost and robustness: **15% cheaper on the page step, and 0 lost pages against 2**, over the
same 100 pages with the checker pinned. The quality edge #344 was filed on **did not reproduce and
was withdrawn there** — a second round put the same paired comparison at McNemar p=0.6636.

What the swap costs is accessibility polish, and the axe count is the weakest way to say it: 4
violations to Kimi's 3, but Kimi's 3 are all `critical` to luna's 1, and 2 of luna's 4 are a
mis-formed `<dl>` on pages that ask for one — a rule you score 0 on by emitting no `<dl>` at all. The
part not in doubt: on the nine map-and-key pages luna passes clean by saying less about the legend
(#347). On the region subtotal rows of a statistical table it drops 23.3% of a 146-row ceiling against
Kimi's 34.9% — better, not fixed, since unswapped Sonnet drops 9.6% and **on that axis the three arms
rank the reverse of their price** (#324).

**`feedback` — keep, and price is not why.** Five dispositions were published for this one agent in
one sprint. Total cost per page favours the swap by 44.9% under the corrector now deployed, because a
verify verdict is not a deliverable: it triggers one correction pass billed to whichever model runs
`page`. Two things hold it open anyway. The cheap arm ties on detection (40 of 45 injected defects
against 39) but **rejects 44 of 45 undamaged pages** at least once, reproducibly on 32 of those 44,
against the incumbent's 22 of 25. And its rate of invented defects is not bounded by 45 pages (#330).

**`copy_editor` — recommended, not applied.** `openai.gpt-5.6-luna` costs 9.5% of the incumbent per
document and is ahead on both quality halves: 21 of 23 provable defect instances against 12, and 5 of
6 documents obeying the issue list against 3 of 10. Worth about **−26% of the bill** (#329). That
result only appeared once the round attached the page images the agent receives in production; the
round that withheld them ranked the two the other way.

**`reader` — declined.** The cheap arm was 77% cheaper at 78% of the incumbent's own agreement floor,
and the decision turned on what the missing 22% was, not on the ratio (#313). Note that 78% is a
ratio of two agreement rates and not a miss rate: it reproduces 118 of 180 reference findings (65.6%)
where the incumbent's own second pass reproduces 152 (84.4%). The absolute per-issue miss is 34%.

## What a benchmark here gets wrong

Every one of these cost this sprint a published figure or a recommendation. They are the transferable
part.

- **There is an agreement ceiling and it is about 84%.** The incumbent reader agrees with its own
  previous pass on 84–85% of issues. Every "% of floor" figure is against that, never against truth.
- **Every share needs its denominator.** This sprint mixed six of them — a round total, the four
  agents a harness prices, one agent's own spend, an 84% floor, 180 anchored issues, and $176.53
  across 63 rounds. It was the single most common way a number went wrong.
- **A share moves when any other term moves.** One agent's share fell while its own cost was
  untouched, because another's rose.
- **Ask what an agent's output causes to happen next, and whether that is inside the unit you are
  quoting.** Priced per call the `feedback` swap looked undecided on figures that were all correct;
  priced per page — including the correction pass a rejection triggers — the same swap is −1.3% or
  −50.9% according to a price that is not the verifier's at all.
- **The unit the pipeline pays for is right for the price and wrong for asking whether a verdict is
  real.** Production reads each page once, so the per-draw rate is what the operating table needs; but
  per page the same arm rejects 44 of 45 clean pages, and one detection credited to it rested on a
  single read of three. Print both denominators and the reads-agreeing count beside any rate taken
  over repeats.
- **A benchmark that withholds an input the agent gets in production measures a different agent.**
  Withholding the page images tied four models on restraint; attaching them separated the same two in
  the opposite direction. The gap was noted in review and read as a scope note. It was the whole
  result.
- **Widen the corpus before publishing the headline.** Three conclusions here were re-measured wider
  and all three moved — and not by sharpening: they changed which model won, or what the trade was.
  "Catches 57 of 57, misses nothing" came from 11 hand-picked pages and missed 5 at 45.
- **A detector calibrated on one model's markup under-reports another's.** Two anchored patterns keyed
  on the tag right after `<p>`/`<li>`; one model wraps inline content in `<em>`, so a **0** was
  published on two axes that were not zero. A false zero flatters the model it was calibrated on,
  which in a cross-model comparison is the worst place for the error to sit.
- **Two arms agreeing is not corroboration when they share a mechanism.** Two vendors in two rounds
  emitted the same wrong page number and agreed exactly. What separated them was a structural
  regularity, not a third vote.
- **A commit distance is not a code distance, in either direction.** Two rounds ten commits apart were
  byte-identical across the pipeline files; two rounds at the same `iris_sha` carried different
  `page.md` bytes. **Diff the blob shas of the prompts, not the commits** — it is free and it answers
  both questions.
- **Re-read the rounds you have already paid for before spending.** Four times in this sprint a free
  re-read of existing records inverted a paid conclusion. It is the cheapest instrument there is and
  it kept being reached for second.

## Re-running any of it

The rounds live in the benchmark repo (`equalify-iris-bench`), which drives this API rather than
importing Iris. Every round persists its raw model replies, so **reading a paid round back costs
nothing.**

```bash
node bystep.mjs runs-postswap-312              # per-agent prices for a mixed-model round
node src/report.mjs --runs runs-extract100-95ca64c   # the three page-model arms
```

Do not read a mixed-model round's price off its `summary.json`: it charges every token at one
model's rate. Read a round's date off its `ledger.jsonl`, not its summary — regenerating a summary
reproduces the figures but not the timestamps.

**Figures published before 2026-09-13 are quoted to four decimals and should not be.** Dollars are
computed at aggregation time from a rate table, and that table has changed: two of three arms in
`runs-extract100-95ca64c` reprice by $0.06 and $0.79 while the third is identical to four decimals —
consistent with a cache-write premium that stopped applying to non-Anthropic models. Orderings, lost
pages and the ~15% and ~39% gaps all hold. Quote two decimals across rounds.

The sprint that produced all of this, including what it got wrong:
[#370](https://github.com/EqualifyEverything/equalify-iris/issues/370).
