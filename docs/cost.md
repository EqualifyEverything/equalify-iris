# What Iris costs

**From $0 to about 11¢ a page. Which one you get is a config choice, not a property of Iris.**

Iris ships no model. `resolveAgentModel` ([src/providers/index.ts](../src/providers/index.ts)) reads
your config and nothing else — every branch ends in a value you wrote, and an unconfigured provider
throws rather than falling back to some default model. So the bill is yours to set:

- **$0 in tokens.** Point `providers.openrouter.base_url` at your own vLLM, ollama or llama.cpp
  server and there is no model bill at all — you pay for the machine. **Nobody has measured what
  that does to quality**, and the agents that read page images need a model that accepts images.
- **About 10.7¢ a page** on the models this repo suggests. That path is benchmarked end to end over
  100 scanned pages, and the rest of this page is where the number comes from.

## Where the 10.7¢ goes

**10.7¢ a page.** 100 pages for a total **$10.7004**, on the suggested models:
`us.openai.gpt-5.6-luna` for the `page` agent, `claude-sonnet-4-6` for the other four. Every row is
measured, but not all in one round: the `extract`, `correct` and `verify` rows come from a three-arm
round run **2026-09-03**; `read`, `edit`, `table_join` and `recheck_sampled` from an end-to-end round
run **2026-09-02**. Same 100 pages, one day apart. A **round** here is one captured run of a fixed
corpus, kept with its own logs and prices — not a round of the review loop, which is the other thing
that word means in this repo ([README § Terms](../README.md#terms)).

| step | agent | cost | share | calls |
|---|---|---|---|---|
| `verify` | `feedback` | $3.5661 | 33.3% | 91 |
| `read` | `reader` | $2.4034 | 22.5% | 40 |
| `edit` | `copy_editor` | $1.8487 | 17.3% | 4 |
| `table_join` | `copy_editor` | $1.2362 | 11.6% | 11 |
| `correct` | `page` | $0.8194 | 7.7% | 64 |
| `extract` | `page` | $0.7641 | 7.1% | 100 |
| `recheck_sampled` | `feedback` | $0.0625 | 0.6% | 4 |

**Where the money goes: 48.7% ($5.2121) producing and checking pages, 51.3% ($5.4883) reviewing and
editing the assembled document.** Those two blocks cover every row above and nothing else. The seven
steps sum to $10.7004, and the share column sums to 100.1% rather than 100% because each cell is
rounded — read it as a decomposition rounded, not a partition.

Three things worth more than the total:

- **7.1% of the bill is spent looking at the source document.** Everything else is checking,
  reviewing and rewriting what that first look produced.
- **Checking a page costs 4.7x what producing it costs** — `verify` $3.5661 against `extract`
  $0.7641.
- **No pages were lost.** All 100 submitted pages produced a file. The previous page model lost 2.

### The last model swap did not change the price

Moving the `page` agent to luna cut what that agent does itself by **39%** — $1.5835 against
$2.5968 for `extract` + `correct`. Both arms are in the one round run 2026-09-03, on the same 100
pages at the same commit, so no prompt change is inside that figure. It was applied to the reference
deployment 2026-09-10.

Then something that is not a model gave it back. Between the 2026-09-02 round and the 2026-09-03 one,
verifier and page-prompt fixes made `verify` **36% more expensive** on identical input — $2.5499 to
$3.4649 checking the same page model's output. (Those are the Kimi arm both times; the table above
prices luna's `verify`.) So about a penny a page came off the page agent and
about a penny a page went onto the checker, and the end-to-end price sat still at about 10.7¢.

**Model choice is not the main lever any more. The prompt is.**

Reproduce the review rows with `node bystep.mjs runs-postswap-312` in the benchmark repo. Do not
read the price off `summary.json`: for a mixed-model round it prices every token at the page model's
rate and reports **$4.21** against the per-agent $10.71. `bystep.mjs` prices per agent.

## Why cost per page is a bad number

It is the number everyone asks for, so it is above — but it hides more than it says.

1. **It varies 2.5x inside one document.** Same model, same run, same report: 2.9¢ a page on pages
   1–25 and 7.1¢ on pages 26–50. Sonnet spread 3.5x. A per-page average says nothing about your
   page.
2. **93% of the bill is arguing about the page, not reading it.** Price follows how often the
   checker objects, which follows how hard your scans are — not how many pages you sent.
3. **A prompt change moved it as much as a model change did.** One day apart: −39% on the page agent
   from a model swap, +36% on the checker from a prompt fix, net zero. A price quoted without a
   commit is not a price.
4. **Pages submitted and pages delivered are different denominators.** The previous page model lost
   2 of 100: 6.1¢ per page submitted, 6.2¢ per page delivered. A model that is cheap because it
   drops pages looks cheap on the wrong denominator.
5. **Repeat runs on identical input disagree** — on 8 pages, and on 19, of the same 100.
6. **The review steps ran on quarter-documents.** `limits.max_pages` is 25, so `read` and `edit` ran
   four times over 25-page slices. **What a 100-page document costs to review as one document has
   never been measured**, and review is 51% of the bill.
7. **One document, one genre, no ground truth.** See Scope.

Better questions: *what does a page of my scans cost*, and *how much of that is rework*.

## Which models to run

Every model is named in your config, never in Iris's code, so what Iris suggests are suggestions with
a measurement attached — not defaults. The per-agent table, and what each suggestion was measured on:
**[docs/models.md](models.md)**.

The part of that which is about money: three of the four working agents run the expensive model, and
together they are **85% of the bill**. The unapplied swap that would move it most is `copy_editor` to
luna — 9.5% of the incumbent's cost and ahead on both quality measures, worth about −26% of the bill
([#329](https://github.com/EqualifyEverything/equalify-iris/issues/329)).

## Scope

One document: US Advisory Commission on Intergovernmental Relations report **M-16 (1962), pages
1–100 of 166**, scanned at 150 dpi, sha256 `679f0a95…c797188`. Pure scan with no text layer, **no
ground truth**, one genre (statistical tables), submitted as four 25-page chunks. No second
document, no second genre, no long-document review measurement, and no measurement of the
self-hosted path.

Prices are Bedrock estimates for comparing configurations, not an invoice: Sonnet from a
first-party rate table checked 2026-08-17, luna and Kimi from the AWS price list API checked
2026-08-28. Quote figures to two decimals when comparing across rounds — the fourth decimal is not
real, and publishing it is what hid a repricing for ten days.
