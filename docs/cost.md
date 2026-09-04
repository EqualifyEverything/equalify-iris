# What Iris costs

**10.7¢ a page.** Measured 2026-09-02 over 100 scanned pages — round `runs-postswap-312`, total
**$10.7106**. That is the configuration deployed on that date, priced end to end.

| step | cost | share | calls | model | what it's for |
|---|---|---|---|---|---|
| `extract` | $1.4616 | 13.6% | 100 | `kimi-k2.5` | Reads the page image and writes that page's HTML. **The only step that sees the source document.** |
| `verify` | $2.5499 | 23.8% | 90 | `claude-sonnet-4-6` | Second opinion on that page: pass, or a list of problems to fix. |
| `correct` | $1.0969 | 10.2% | 63 | `kimi-k2.5` | Rewrites the page to fix what `verify` rejected. Ran on 63 of 90. |
| `recheck_sampled` | $0.0625 | 0.6% | 4 | `claude-sonnet-4-6` | Spot-checks a sample of corrections to see whether the fix held. |
| `table_join` | $1.2362 | 11.5% | 11 | `claude-sonnet-4-6` | Stitches a table split across a page break. Only runs when code cannot do the join itself. |
| `read` | $2.4034 | 22.4% | 40 | `claude-sonnet-4-6` | Reviews the assembled document and writes findings. Loops. |
| `edit` | $1.8487 | 17.3% | 4 | `claude-sonnet-4-6` | Applies those findings to the document. |
| **failed** | $0.0513 | 0.5% | 2 | `kimi-k2.5` | Two `correct` calls that errored. Billed, bought nothing. |
**Where the money goes: 59.8% ($6.4071) producing and checking pages, 39.7% ($4.2521) reviewing and
editing the finished document, 0.5% ($0.0513) wasted.** Those three blocks cover every step above and
nothing else. The eight steps sum to $10.7105 against the round's ledger total of $10.7106 — the tenth
of a cent is the per-step cells being published to four decimals. For the same reason the share column
sums to 99.9% rather than 100%, so read it as a decomposition rounded, not as a partition.

Two things the table says that are worth saying out loud:

- **Only 13.6% of the bill is spent looking at the source document.** The other 86% is Iris checking,
  repairing, reviewing and editing its own output.
- **Checking a page costs about two and a half times as much as producing it.** `verify` + `correct` +
  `recheck_sampled` is **34.6%** of the bill against `extract`'s 13.6%.

Read the cost column alongside the share column, not instead of it. A step's share moves when *any
other* step's cost changes: across the last model swap `table_join`'s share rose from 8.6% to 11.5%
while its actual spend **fell 26%** ($1.6701 → $1.2362).

## About the sample

**What it is.** 100 pages of a 1962 report of the US Advisory Commission on Intergovernmental
Relations — dense hierarchical statistical tables, no charts, little running prose. Rendered at 150
dpi. In the benchmark repo as **`pages100/`**, page ids `acir-p001`–`acir-p100`. Name the corpus when
you quote a figure from it: a second corpus there, `pages-hard57/`, uses the same `acir-pNNN` ids, and
one published figure of "54% more per call" was **18%** on the 57 pages the choice actually applied
to.

**Source PDF: not recorded.** The corpus stores provenance as a bare content hash and the PDF is not
in the benchmark repo, so nothing anywhere names a URL. The hash is sha256
`679f0a956868fa935b3bec38ebd83b3fb486e74dd87762e17248bc523c797188`. Finding the original needs a
person — ACIR published it, and a HathiTrust or archive.org copy would do — and this section should
then carry the URL beside the hash, so a reader can confirm the copy they fetched is the one measured.

**Five things that bound every number above:**

1. **It is one document, not four.** The round reports "4 documents" because this deployment caps a
   request at 25 pages (`limits.max_pages: 25`), so the PDF was submitted as four 25-page pieces.
   `read` and `edit` therefore ran four times over four quarter-documents. **The cost of reviewing a
   whole 100-page document has never been measured.**
2. **Pure scan, no text layer.** `text_layer: false` on all 100 pages, so every step worked from
   pixels. A PDF that already carries text is a different price and is not measured here.
3. **No ground truth.** `truth_words: 0` on all 100 pages. Every quality figure Iris reports on this
   corpus is a model or a script judging output, never a comparison against a known-correct
   transcription.
4. **One genre.** Statistical tables. It is why some agents never fire at all on this corpus, and it
   is the standing limit on every figure here.
5. **Repeat runs on identical input disagree on 8 and 19 pages of 100.** The cost column is token
   spend and reproduces to four decimal places. Quality figures carry that noise.

## What could change it

**#324** and **#344** are both live proposals to change the page model, and either moves the
`extract`, `correct` and `failed` rows. **#329**'s copy-editor swap is measured at −26.1% and
unapplied. The three largest levers left are not model choices at all: **#369**, **#324**'s free
artifact check, and **#365**. Each carries its own price and its own evidence; this document does not
restate them.

## Where the rest of it went

This document used to be the sprint's report as well as its price sheet. The report is now
**[docs/sprint-246.md](sprint-246.md)** — every per-model comparison, the errata against
[#370](https://github.com/EqualifyEverything/equalify-iris/issues/370), what the sprint got wrong, and
the open handoffs with their prices. Per-agent detail, call sites and the older rounds are
**[docs/models.md](models.md)**.

## Reproducing the table

```bash
node bystep.mjs runs-postswap-312   # the table above, with its own arithmetic check
node -e 'console.log(require("./pages100/index.json")[0])'   # the corpus record
```

Both run in the benchmark repo (`equalify-iris-bench`), which drives this API rather than importing
Iris. Every round persists its raw model replies, so reading a paid round back costs nothing. Two
things to check before combining a figure here with a new round's: **the prompt's blob sha**, not the
commit — two rounds ten commits apart have turned out byte-identical, and two rounds at the same
`iris_sha` have carried different `page.md` bytes — and **the denominator**, because pages submitted,
pages that produced a file, and calls are three different counts.
