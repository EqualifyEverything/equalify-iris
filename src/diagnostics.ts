// Distills a session's log.jsonl into a machine-readable health/timing summary
// for maintainers — human or AI. The key signal for "is it hung?" is
// `in_flight.waiting_ms`: a model call that started but has not finished.

interface LogEvent {
  ts?: string;
  type?: string;
  phase?: string;
  agent?: string;
  step?: string;
  model?: string;
  provider?: string;
  capability?: string;
  duration_ms?: number;
  ok?: boolean;
  error?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

// What a set of model calls cost and took. Shared by `by_agent` and `by_step` so the two
// splits are the same seven numbers over the same calls, differing only in how they are
// keyed — a reader comparing them is comparing groupings, never definitions.
export interface CallTotals {
  count: number;
  total_ms: number;
  max_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface Diagnostics {
  session_id: string;
  status: string;
  phase: string;
  started_at: string | null;
  last_event_at: string | null;
  elapsed_ms: number;
  // Non-null only while a model call is outstanding (likely culprit if hung).
  // When extraction runs pages in parallel, several calls can be open at once;
  // this reports the longest-waiting one.
  in_flight: null | {
    agent: string;
    // Which job is waiting, since that is what a stuck run is asked about first and the agent
    // name does not settle it — `feedback` in flight is a page being checked or a user's
    // feedback being routed, and only one of those is on the critical path of a delivered page.
    step: string;
    model: string;
    provider: string;
    capability: string;
    since: string;
    waiting_ms: number;
  };
  // How many model calls are outstanding (0 unless running). > 1 means pages are
  // being extracted in parallel.
  in_flight_count: number;
  phase_durations_ms: Record<string, number>;
  // `total_ms` is the SUM of call durations, which exceeds wall-clock time when
  // calls overlap — that is the point of `concurrency_factor`
  // (total_ms / elapsed_ms, rounded to 2dp): ~1 means effectively serial, ~N
  // means N calls were typically in flight. Use elapsed_ms for wall-clock.
  model_calls: {
    count: number;
    failed: number;
    total_ms: number;
    avg_ms: number;
    max_ms: number;
    concurrency_factor: number;
  };
  // What the run consumed, in tokens. Deliberately not in dollars: the rate depends
  // on the provider, the region and the model, all of which are deployment config and
  // any of which can change without this file knowing — the same reason the limits
  // endpoint publishes sizes without naming the model behind them. Tokens are the
  // durable fact; whoever knows the price sheet does the multiplication.
  //
  // The four counts bill at four different rates, so they are reported separately
  // rather than as a total. `calls_reported` is how many of `model_calls.count`
  // carried any usage at all: when it is lower, these sums cover only part of the run
  // and a cost derived from them is a floor, not an estimate.
  tokens: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    calls_reported: number;
  };
  // Per-agent totals are the attribution that matters for both halves of the bill:
  // which agent is slow, and which one is expensive. They are not the same agent.
  //
  // All four token counts, not just input and output: `input_tokens` excludes what was
  // read from the cache, so on a deployment that caches, a two-field split understates
  // an agent's prompt by exactly its cached share — and understates it worst for the
  // agent that caches best, which inverts the answer the split exists to give. Keyed as
  // the log line keys them, so the names that cross the adapter/diagnostics seam are the
  // same ones in both places.
  by_agent: Record<string, CallTotals>;
  // Per-STEP totals: the same seven numbers, keyed by the job that bought the call rather
  // than by the agent file that answered it (`PipelineStep` in providers/types.ts).
  //
  // This is the split a per-step cost claim has to be read off, and `by_agent` is not it.
  // One agent serves several jobs, so an agent's row is a sum over jobs and a job's cost can
  // be spread across rows: extraction's per-page fidelity check books to `feedback`, which
  // reported the extraction step at 41% of a document when its jobs together are 57.2% (#280),
  // and the table-join step's whole bill arrived inside `copy_editor` next to the review
  // round's (#243). Both are unrecoverable from `by_agent` at any effort, because the
  // information is not in it.
  //
  // Kept ALONGSIDE `by_agent` rather than replacing it, because the two answer different
  // questions and both get asked: `by_agent` is what a deployment reads to decide a
  // per-agent model override (`providers.per_agent`, which is keyed by agent), and a step
  // cannot be pointed at a model. Read together they also localize a cost: a step that grew
  // while its agent's row did not is a step that took work from another one.
  by_step: Record<string, CallTotals>;
  slowest_calls: { agent: string; step: string; model: string; capability: string; duration_ms: number; ok: boolean }[];
  errors: { ts: string | null; type: string; message: string }[];
  // What the verify-then-correct loop did, and what it bought.
  //
  // Every page is checked against its source image and a page that fails is re-rendered
  // once, so a run's page-call count is `pages + corrections` and a high failure rate turns
  // an optional pass into a mandatory one — 58 of 75 pages across three real runs, with
  // verification alone at 24% of one document's bill (issue #137). `corrections` and not
  // `verify_failed`, because a page that PASSED its check is re-rendered too when the code
  // finds a link the model dropped, and that costs the same page call: see `triggers`.
  // None of that was
  // visible here: the log recorded the verdicts and said nothing about the corrections,
  // so the loop's cost was inferable from arithmetic and its value not at all.
  //
  // The counts, not the rates: `verify_failed / (pages_verified - pages_unjudged)` is the
  // rejection rate — over the pages a verdict was actually read from, see below — and
  // `results.identical + results.empty + results.failed` is what was paid for and bought
  // nothing — bought, not discarded: an `identical` fragment is still what ships, since what
  // the page call failed to buy is a change and not a page. `rejected` is the one that was
  // thrown away, and `failed` the one that cost the most, since a correction that hit the
  // output ceiling paid for a full ceiling of tokens before failing (issue #171) — leaving it
  // out of that sum would hide the most expensive of the three. But a
  // consumer that wants a percentage can divide, and a percentage over three pages is not
  // a measurement. Summed over every run this session has had, like `model_calls` — a
  // feedback round verifies pages again, and both times count.
  verification: {
    pages_verified: number;
    // Of those, the pages nothing actually judged: no Feedback Agent loaded, nothing to
    // verify, a reply that would not parse. `verifyAgentOutput` answers ok=true in all three
    // so that verification can never break a run (pipeline/feedback.ts), which means "the
    // verifier looked and was satisfied" and "nobody looked" arrive at this fold as the same
    // event — and a run that lost its Feedback Agent halfway through reads as a run with an
    // unusually good pass rate.
    //
    // A SUBSET of `pages_verified` rather than a deduction from it, deliberately: that field
    // is compared across runs and benchmark rounds, and quietly changing what it counts
    // would move every published number without saying so. `verify_failed / (pages_verified
    // - pages_unjudged)` is the rejection rate over the pages that were actually judged.
    //
    // Zero on every log written before the flag existed, which is the one thing it cannot
    // distinguish: an old run with no Feedback Agent reported the same `page_verify_ok`
    // lines as a passing one, and nothing recoverable from the file says which (issue #211,
    // and #180 for the measurement that needed it).
    pages_unjudged: number;
    // Of THOSE, the pages nothing looked at because nothing was bought: a page the agent declared
    // blank, whose fragment is empty and which is no longer sent to the Feedback Agent at all
    // (issue #294, `page_verify_ok` with `skipped: "blank"`). A subset of `pages_unjudged`, which is
    // a subset of `pages_verified`, so neither of those moves and no published rate changes — what
    // this adds is the ability to tell a saving from a failure, because until it existed a run that
    // skipped 9 calls and a run whose Feedback Agent would not load produced the same two numbers.
    //
    // It is also the only way to PRICE the skip from a delivered run: this count times the cost of a
    // verify call on an empty fragment ($0.0095 against $0.0212 for an average page, measured on the
    // bench's 100-page corpus) is what the run did not spend. Zero on every log written before the
    // skip, where those pages were verified and counted in `pages_verified` exactly as they are now.
    //
    // Calls not bought, which is money not spent only where there was a verifier to spend it on: a run
    // with no Feedback Agent loaded skips the blank page's call too and saves nothing by it.
    // `pages_unjudged == pages_verified` is consistent with that run and does not identify it — the
    // same equality comes out of a run whose verifier loaded and whose every reply failed to parse,
    // where the calls were bought — so the thing to read is the calls: `by_step.verify.count` below is
    // 0 where no verdict was bought at all. The flag deliberately does not depend
    // on whether the agent loaded — it would make one field mean two things, and it would put a disk
    // check in the extraction path to decide a label.
    pages_skipped_blank: number;
    verify_failed: number;
    // `verify_failed` split by what the verifier said was WRONG, counted in pages
    // (pipeline/feedback.ts `VERIFY_KINDS`). Two bench rounds rejected 74 of 94 and 76 of
    // 100 pages, and no field here could say whether that was content arriving missing or
    // descriptions being polished — a page that lost three table rows and a page whose alt
    // text went from "orange kayak" to "orange-yellow kayak" were the same line (issue
    // #182). `effects` answers the same question from the other end, and only about
    // corrections that changed something; this one is about every page that failed.
    //
    // NOT a partition, for the same reason `effects` is not: a page with a missing row and a
    // thin alt counts in `content_missing` and in `alt_quality`, so these sum to at least
    // `verify_failed` and usually more. Read each against `verify_failed`, not against the
    // total. Pages and not problems, so that one page naming six things cannot outweigh six
    // pages naming one each — `verify_failed` is a page count and these have to divide into
    // it.
    //
    // `untagged_pages` is what keeps the rest honest: a verdict from an agent file that
    // predates the kinds, or a trained one whose contract was rewritten without them, names
    // its problems in prose with no kind at all. Those pages are in `verify_failed` and in no
    // kind bucket, so a split read without it beside them is a split of the tagged share
    // reported as the whole run. A page can be here AND in a kind bucket, when some of its
    // problems were tagged and some were not — which is why the name says `pages`: the count
    // on the log line it is folded from is a count of PROBLEMS, and the two are different
    // numbers on the same run. `verify_untagged_problems` below is that other unit, because a
    // run that lost one tag per page and a run that lost every tag report the same
    // `untagged_pages` and only the second makes the split unusable.
    verify_kinds: {
      content_missing: number;
      content_wrong: number;
      structure_wrong: number;
      a11y_only: number;
      alt_quality: number;
      untagged_pages: number;
    };
    verify_untagged_problems: number;
    // Pages the verifier PASSED while naming a problem, and what it named. A verdict's `ok` is
    // its `faithful`/`accessible` flags, and a correction is bought only when a flag is false
    // AND a problem is named (pipeline/extraction.ts `failedCheck`), so a verdict that
    // describes a defect with both flags true ships the page and the sentence it wrote is not
    // even in the log — `page_verify_ok` carries no `problems`. Calibrating the verifier
    // against injected defects found 3 of 30 damaged pages described in full and passed, which
    // is most of the gap between what it perceived (28 of 30) and what it flagged (25) — a
    // different failure from a verifier that cannot see, and a different repair (issue #210).
    //
    // `pages` counts them; the five kind fields split them the way `verify_kinds` splits the
    // failures, in pages and not a partition. `content_or_structure` is the pricing field:
    // pages naming at least ONE of `content_missing`, `content_wrong` or `structure_wrong`,
    // which is exactly the population a kind-gated failure rule would newly fail and newly pay
    // a correction for. The complement is not a bug to fix — an `alt_quality` suggestion on a
    // page that ships is the Feedback Agent doing what it was asked.
    //
    // `undecided_pages` is the unknown ABOVE that floor: pages where a kind-gated rule has
    // nothing to decide on, because a problem arrived with no kind this code knows and no
    // content or structure kind was named either. So `content_or_structure` is the least such a
    // rule would cost and `content_or_structure + undecided_pages` the most, and the two can be
    // added because neither contains the other. That is deliberately NOT the rule beside
    // `verify_kinds`, whose `untagged_pages` counts a partly-tagged page too: there the field
    // audits a SPLIT, and a page with one tag missing is a page whose split is incomplete;
    // here the question is whether a decision can be made, and a page already naming
    // `content_missing` is decided whatever else it left untagged.
    //
    // Nothing in the run reads any of this: the event decides nothing, and these counts exist
    // so the rule can be priced over a fleet before it changes what pages cost. Zero on every
    // log written before the event, which cannot be distinguished from a run where it never
    // happened.
    verify_inconsistent: {
      pages: number;
      content_missing: number;
      content_wrong: number;
      structure_wrong: number;
      a11y_only: number;
      alt_quality: number;
      content_or_structure: number;
      undecided_pages: number;
    };
    corrections: number;
    // How each correction pass ended: `kept` CHANGED the delivered document, `rejected` was
    // discarded in favour of the fragment it was meant to improve — either because it came
    // back at a fraction of that fragment's size, on any trigger, or because the links path's
    // re-verification found the rewrite had lost something — `identical` changed nothing about
    // the page, `empty` returned nothing usable, `failed` never answered at all — the model
    // call threw (a truncation, a stall, a throttle) and the page kept the version it had.
    // The last three are calls that bought nothing — `identical` on the effect and not on
    // string identity, so a model that re-typed its own page to no purpose is counted here
    // rather than inflating `kept`, which is the number these fields exist to make honest.
    //
    // `failed` is apart from `empty` because it is the expensive one: a correction that hit
    // the output ceiling has paid for a full ceiling of tokens before failing, where an
    // `empty` one usually answered briefly and said nothing. A run whose `failed` count is
    // not zero has a `providers.*.max_tokens` to raise or a page too large to correct in one
    // reply, and neither is visible if the two are summed (issue #171).
    //
    // How to read `rejected: 0`, since two bench rounds produced it over 145 corrections and
    // it was reported as a gate that accepts everything (issue #166). It was not a gate. Until
    // the shrink floor landed, `rejected` was reachable on the LINKS trigger alone — a page
    // that had passed its check, was re-rendered for a link, and lost something — so a round
    // whose corrections were all verify-driven could not produce a rejection at any rate of
    // badness, and the zero measured the absence of a rejection path rather than the absence
    // of bad corrections. `CORRECTION_SHRINK_FLOOR` (pipeline/correction.ts) is the first one
    // that applies on every trigger. It is deliberately a floor and not a judgement, so
    // `rejected: 0` is still the expected reading of a healthy round: it counts corrections
    // that came back at a fraction of the page they were given, which is a parser or ceiling
    // failure and not a bad rewrite. A correction that is merely WRONG is kept, and
    // `rechecks.sampled_problems_*` is where that shows up — see extraction.ts on why
    // discarding it would ship the fragment that already failed the same verifier.
    results: { kept: number; rejected: number; identical: number; empty: number; failed: number };
    // Why each correction ran: `verify` is a page the Feedback Agent rejected, `links` is a
    // page that passed and lost a link the code found in the PDF, `alt` is a page that passed
    // and described an image with a placeholder instead of a description (pipeline/alt.ts,
    // #290), and `both` is one with more than one of those. These are the split that makes
    // `corrections` readable as a bill — a `links` or `alt` correction is a page call with no
    // verify failure behind it, so a consumer reading `verify_failed` as the number of extra
    // page calls undercounts by both of them.
    //
    // `alt` is expected to be 0 on a healthy run, and that is the point of counting it: the
    // rule flags nothing in Iris's own output (0 of 1,064 alts across the bench corpus), so a
    // non-zero here is either a page agent that has started writing placeholders or a
    // regression in the rule, and both are worth a look. It is not a cost line at that rate.
    triggers: { verify: number; links: number; alt: number; both: number };
    // What the corrections that DID change something changed, as observed on the two
    // fragments rather than claimed by the verdict (pipeline/correction.ts). Not a
    // partition: a re-render that rebuilds a table counts under both `text` and
    // `structure`. `alt_only` is the one that stands alone, and it is the interesting one
    // — a run whose corrections only ever refine alt text is paying a page call per page
    // for image descriptions. `attrs` is every attribute but alt, which is where the
    // cheapest real fixes live: an `href` the model re-typed, a `<th scope>`, an
    // `aria-describedby` — a correction that moves no word and matters.
    //
    // `text_grew` and `text_shrank` split `text` by DIRECTION, on the size of the prose a
    // reader receives rather than of the fragment: how many corrections added words, how
    // many removed them, and — on a log where every line carries the sizes — by subtraction
    // how many rewrote the same quantity of prose in place. A line from before the sizes
    // existed still counts under `text` and lands in neither direction, so that subtraction
    // absorbs it as an equal-length rewrite; a session's log is append-only across rounds and
    // this sums all of them, so a session that takes a feedback round across the upgrade has
    // exactly that mixed log. `text_grew + text_shrank` against `text` is the honest reading
    // there. That is what makes a high `verify_failed` rate readable. Two bench rounds put
    // it at 71% and 74% of pages, with `attrs` and `structure` touched on nearly every
    // correction and `text` on fewer — which reads either as most pages arriving with
    // content missing, or as most pages arriving fine and being polished, and the counts
    // could not tell the two apart (issue #166). A round whose corrections cluster in
    // `text_grew` is recovering content the vision pass dropped; one that barely leaves
    // `attrs` and `structure` is buying markup on pages that were already readable, and the
    // cheaper remedy for that is the page prompt, not a call per page.
    //
    // No threshold: a correction that adds one character counts as `text_grew`, because any
    // band that called that "cosmetic" would be a number picked rather than measured. The
    // magnitudes are on each `page_corrected` line (`text_chars_before`, `text_chars_after`)
    // for a consumer with a corpus to calibrate one on.
    effects: {
      alt_only: number;
      text: number;
      attrs: number;
      structure: number;
      text_grew: number;
      text_shrank: number;
    };
    // Second verdicts on a corrected page, kept apart by whether the verdict was allowed to
    // decide anything, because the two answer different questions and a single ok-rate over
    // both answers neither.
    //
    // `sampled` is the measurement-only sample — `defaults.recheck_sample_size` pages per
    // batch, one by default (correction.ts `recheckSampler`) — taken on a page that FAILED its check and was re-rendered, so
    // `sampled_ok / sampled` is whether correction converges: the number that says whether
    // the loop is worth its 24%. It accumulates one or two per run, so it is a fleet
    // measurement and not a per-document one.
    //
    // `binding` is the links path's own re-verification, which keeps or discards the
    // rewrite. Those pages had already PASSED verification and were re-rendered only to
    // recover a link, so their ok-rate is "did a rewrite of a good page stay good" — a
    // different question, and on a link-heavy PDF there is one per page, which would swamp
    // the sample if the two were summed.
    //
    // `sampled_problems_before` and `sampled_problems_after` are how many FIDELITY problems
    // those sampled pages were sent to be corrected with, and how many the second verdict
    // named, summed over the sample. `sampled_ok` on its own read as a pass/fail on a
    // single-shot pass that was never expected to reach zero — four samples, four not-ok, and
    // no way to see whether the corrections had fixed most of what was flagged or none of it
    // (issue #166). 11 problems in and 3 out is a loop that mostly works; 11 and 11 is one
    // that does not, and both are `sampled_ok: 0`.
    //
    // Fidelity problems and not the correction's whole bill, because the two sides have to be
    // comparable: a correction is also given the links the code found missing, and the second
    // verdict judges the fragment against the IMAGE, where a link target does not appear — so
    // a link counted going in could never be counted coming out, and a page with one verdict
    // problem and three missing links would report four-in-one-out for a correction that fixed
    // nothing the verifier named. The event carries the link share as `links_before`, and
    // `page_corrected`'s `problems` is the whole bill.
    //
    // Sums over pages, so a single page with many problems moves them more than several with
    // one each — read them as a ratio and not as a per-page average, and against the samples
    // they were summed over, which is `sampled` less the unjudged ones and less any line too
    // old to carry both counts (see the field below).
    // And `sampled_problems_after: 0` does not mean the sample passed: the verdict's `ok` is
    // its `faithful`/`accessible` flags (pipeline/feedback.ts), which an agent can set false
    // while naming nothing, so `sampled_ok` remains the answer to whether it passed.
    //
    // The binding population has no such pair, for the reason it is counted apart: those pages
    // had PASSED their check, so their `problems_before` is 0 by construction and the question
    // their verdict answers is whether the rewrite lost something, not how far it got.
    //
    // `*_unjudged` is `pages_unjudged`'s argument one fold down, and the binding one is where
    // it bites: a recheck's `ok` is also what an unavailable Feedback Agent looks like, and
    // with none loaded every page passes its first check, so every corrected page's recheck is
    // the BINDING one and every one of them is a "the rewrite was checked and stayed good"
    // line for a page nobody looked at. Subsets of the counts above rather than deductions
    // from them, so those totals keep counting what they always counted. Zero on every log
    // written before the flag.
    //
    // The judged-only rate is `(binding_ok - binding_unjudged) / (binding - binding_unjudged)`,
    // and the same shape for sampled — BOTH sides, which is where this differs from the fold
    // two levels up. There, subtracting from the denominator alone is exact, because
    // `verify_failed` can only come from `page_verify_failed` and an unjudged verdict cannot
    // produce one, so the numerator and `pages_unjudged` are disjoint. Here the numerator is a
    // PASS count and an unjudged recheck is a pass by construction — every one of them is
    // inside `binding_ok` — so denominator-only subtraction reports a rate above 100%.
    rechecks: {
      sampled: number;
      sampled_ok: number;
      sampled_unjudged: number;
      // Summed over the JUDGED samples only — an unjudged recheck contributes neither, even
      // though its line carries a real `problems_before`. Its `problems_after` is 0 because
      // nothing was named, not because nothing was left, and pairing a true before-count with
      // a non-verdict after-count would report that page as a correction that fixed
      // everything it was given. Unlike `*_ok` there is no field to back that out of, and no
      // published number moves by leaving it out: only a log carrying the flag can be
      // affected, and the flag is newer than every round measured so far.
      sampled_problems_before: number;
      sampled_problems_after: number;
      binding: number;
      binding_ok: number;
      binding_unjudged: number;
      // The failing verdicts themselves — not a count; the counts are `sampled - sampled_ok`
      // and `binding - binding_ok`. One entry per recheck that named a problem, carrying the
      // prose it named it in, because that prose is the whole answer to "what is still wrong
      // with the page that shipped" and nothing else in this file holds it: the counts say a
      // correction did not converge and never say what it failed to fix.
      //
      // Here rather than in `errors`, which used to hold these and rendered every one of them
      // `message: "unknown"` — it reads `error`, and this event's diagnosis is `problems`
      // (issue #296). Moving it rather than fixing that message is the other half of the same
      // issue: a second verdict is a measurement, and `errors` has to be readable as "the run
      // is in doubt". So the diagnosis is beside the numbers it explains instead.
      //
      // BOTH populations, marked by `binding`, because the two failures are worth reading and
      // are not the same reading: a sampled failure is a page that shipped still wrong, and a
      // binding failure is a rewrite that was refused so the page shipped as it was. `null`
      // there is a line that did not say, which the counts above put in neither bucket — kept
      // here anyway rather than dropped, since the verdict is a fact about a page whatever the
      // line failed to say about its own population.
      //
      // Failing only, so an `ok: true` recheck adds nothing: `failedCheck` (extraction.ts) is
      // `!ok && problems.length > 0`, so a line logged `ok: false` always names at least one
      // problem and an entry here can never carry an empty message. Which also means an
      // unjudged recheck is absent by construction — it logs `ok: true`.
      failures: { ts: string | null; page: number | null; binding: boolean | null; message: string }[];
    };
  };
  // Source pages whose own extraction threw, so the delivered document carries a
  // failure marker instead of that page's content (pipeline/extraction.ts
  // `failedPage`). Its own field because a run that ends `ready_for_review` with a
  // page missing is otherwise indistinguishable here from one that delivered the
  // whole document: the failed model call underneath shows up in `errors` exactly as
  // a retried-and-recovered one does, and `status` says the run succeeded — which it
  // did, on 24 of 25 pages.
  pages_failed: number[];
  // Source pages the agent read and reported empty, so the document has no content for
  // them BECAUSE THERE WAS NONE (pipeline/extraction.ts `declaredBlank`). Kept apart from
  // `pages_failed` because the remedy is opposite: a failed page is work to redo, and a
  // blank page is work already finished. Six pages across three of four bench documents
  // were reported as failures before this split, which made a document with a blank verso
  // look partial to every client following docs/API.md §7c.
  //
  // Not subtracted from anything: `pages` in `run_complete` counts source images, blank
  // ones included, so `pages - pages_blank.length` is the count that produced markup. The
  // two sets are disjoint, and stay disjoint across feedback rounds: a page that failed in
  // round 1 and came back blank in round 3 has been answered, so it leaves `pages_failed`
  // (as `page_recovered`) and arrives here.
  pages_blank: number[];
  // Fidelity discrepancies the Copy Editor noticed on a page whose image it had and was not
  // asked about (pipeline/review.ts `readFidelityObserved`, issue #183). The first fidelity
  // signal in the pipeline that does not come from the check that produced the page: VERIFY
  // runs once per page during extraction, and its blind spots are the transcriber's by
  // construction — same model family, same image, same failure modes — so an observation here
  // on a page VERIFY passed is a measured miss rather than an inferred one.
  //
  // Read as evidence, NOT as a rate. The editor only ever sees the images for pages the Reader
  // attributed an issue to, which skews toward pages that already had something wrong with them
  // and is no sample at all of a document the Reader read clean. `observed` over `pages` tells
  // you how concentrated the observations were and nothing about the document's other pages.
  //
  // `unattached` and `unplaced` bound how much of it is checkable: an observation about a page
  // whose image was not attached is a guess about a page the model could not see (the prompt
  // asks for attached pages only), and one that named no page cannot be traced to a page at all.
  // Both are counted rather than dropped, so subtracting them is the reader's choice; `kinds`
  // uses the same five as `verification.verify_kinds` on purpose, so the two splits can be read
  // against each other.
  //
  // `pages` is every page an observation named, guesses included, because `pages` is where a
  // person should look and a guess that turns out to be right is worth the look. `unattached_pages`
  // is the subset of it the editor could NOT see, so the difference is the set backed by an image
  // the model had in front of it — that decomposition is why the page list is a union rather than
  // two disjoint fields.
  fidelity_observed: {
    observed: number;
    pages: number[];
    unattached_pages: number[];
    kinds: {
      content_missing: number;
      content_wrong: number;
      structure_wrong: number;
      a11y_only: number;
      alt_quality: number;
      untagged: number;
    };
    unattached: number;
    unplaced: number;
  };
}

function parse(logText: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (const line of logText.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEvent);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

// How a correction pass can end (pipeline/extraction.ts `page_corrected`). A closed
// list, so a `result` this version does not know counts as a correction and is
// attributed to nothing rather than inventing a bucket for it.
const CORRECTION_RESULTS = ["kept", "rejected", "identical", "empty", "failed"] as const;

// And why it ran. A closed list for the same reason, and read off the same event. `alt` since
// #290; `both` has always meant more than one source, so adding a third source does not change
// what an old log's `both` counted.
const CORRECTION_TRIGGERS = ["verify", "links", "alt", "both"] as const;

// What the Feedback Agent said was wrong with a page (`page_verify_failed`'s `kinds`).
// Declared here rather than imported from pipeline/feedback.ts, like the two lists above
// mirror extraction.ts: this module reads a log file and nothing else, and a kind a future
// version adds should be visible as ungraded on an old reader rather than change this file's
// dependencies. The five are defined in agents/feedback.md and pinned in
// pipeline/feedback.ts `VERIFY_KINDS`; test/verify-kinds.test.ts holds the two lists equal.
//
// That visibility is only complete where a line names NO kind this reader knows: then the page
// is in `untagged_pages` and its problems are in `verify_untagged_problems`. A newer writer that
// mixes a sixth kind with one of these five logs `untagged: 0` — it recognized its own tag — so
// the old reader sees one known kind, no untagged count, and the sixth-kind problem is silently
// absent from the split rather than visibly ungraded. It needs a sixth kind shipped AND an old
// reader folding a newer log (a retained bench log, a diagnostics read mid-deploy), which is why
// it is written down here rather than coded around: inside one deploy the two lists cannot
// diverge, and the test above is what keeps that true.
const VERIFY_KINDS = ["content_missing", "content_wrong", "structure_wrong", "a11y_only", "alt_quality"] as const;

// The longest a model call can legitimately still be open, used to tell a run that is
// working from one whose process is gone (see `abandoned`). Derived, not picked: each
// adapter abandons a stream at an absolute 15-minute ceiling (providers/bedrock.ts,
// providers/openrouter.ts `MAX_TOTAL_MS`) and OpenRouter retries at most three times, so
// ~45 minutes is the worst case a caller can produce. An hour is that, rounded up — far
// enough past it that this never cuts off a call still running, and short enough that a
// killed run stops claiming to be stuck within one.
const MAX_PLAUSIBLE_CALL_MS = 60 * 60_000;

const ms = (a?: string, b?: string): number =>
  a && b ? Math.max(0, new Date(b).getTime() - new Date(a).getTime()) : 0;

// A verifier's verdict as one line, for `verification.rechecks.failures`. The problems in
// FULL and not the first of them: they are one or two sentences of the Feedback Agent's own
// prose about a specific page, no order is claimed among them (extraction.ts logs the list
// as the agent gave it), and the one that would be dropped is as likely as any to be the
// reason the page is wrong. Counted first when there is more than one, so a reader can see
// at a glance whether a correction left one problem behind or five.
//
// Defensive about the shape for the reason every read in this file is: this runs over a log
// line that may have been written by an older Iris or hand-edited, and a `problems` that is
// not an array of strings must produce a sentence rather than `undefined` or a crash. The
// fallback names the field it looked in, so "the verdict said nothing" and "this line does
// not carry the verdict" are different strings — which is exactly the distinction the
// `"unknown"` this replaces could not make (issue #296).
const verdictMessage = (e: LogEvent): string => {
  const problems = Array.isArray(e.problems)
    ? e.problems.filter((p): p is string => typeof p === "string" && p.trim() !== "")
    : [];
  if (!problems.length) return "no problems on the line";
  return problems.length === 1 ? problems[0] : `${problems.length} problems: ${problems.join(" | ")}`;
};

export function summarizeRun(
  logText: string,
  ctx: { sessionId: string; status: string; phase: string; now: number },
): Diagnostics {
  const events = parse(logText);
  const running = ctx.status === "running" || ctx.status === "queued";
  const nowIso = new Date(ctx.now).toISOString();

  const startedAt = events[0]?.ts ?? null;
  const lastEventAt = events.length ? events[events.length - 1].ts ?? null : null;
  // The terminal line of the CURRENT run, not the first one in the file.
  //
  // A session's log is one append-only file across every round it has (store/runlog.ts),
  // so a session that has taken feedback holds several `run_start` … `run_complete`
  // pairs. Reading the first terminal event therefore answered "did the FIRST run
  // finish?" — which is always yes by the time a feedback round exists, since a round is
  // only accepted on a session that already reached `ready_for_review`. Two things rested
  // on that answer and got the wrong one: how long the session has been working, which
  // stopped counting at the first round's completion however many rounds followed, and
  // whether a call is still open, below.
  const runStart = events.map((e) => e.type).lastIndexOf("run_start");
  const currentRun = runStart === -1 ? events : events.slice(runStart);
  const terminal = currentRun.find((e) => e.type === "run_complete" || e.type === "run_failed");
  // Counted rather than read off the slice above, because a session's rounds are not
  // always laid end to end: a client may POST /feedback during a round's post-delivery
  // window (pipeline/orchestrator.ts), and with `max_concurrent_runs` above 1 the second
  // round's `run_start` is then appended before the first round's `run_complete`. The
  // slice would hold that trailing line and read as finished. A count cannot be fooled by
  // the interleaving: as many terminal lines as starts means every round is done.
  const roundsStarted = events.filter((e) => e.type === "run_start").length;
  const roundsEnded = events.filter((e) => e.type === "run_complete" || e.type === "run_failed").length;
  const unfinished = roundsStarted > roundsEnded;

  // In-flight detection. Extraction runs several pages concurrently, so more
  // than one call can be open at once and start/end events interleave. Match
  // them by identity (agent+step+model+capability) rather than position: each end
  // event closes the OLDEST matching open start, which is the same pairing a
  // FIFO queue would produce. `in_flight` reports the longest-waiting open call
  // — the best single answer to "what is this run stuck on?" — and
  // `in_flight_count` shows how many are outstanding.
  // Over the current run only, for the same reason the terminal lookup is: an earlier
  // round's call that never closed — a process killed mid-flight — is not what THIS run
  // is stuck on, and reporting it as such is the phantom hang again by another route.
  const openCalls: LogEvent[] = [];
  // `step` is part of the identity, not decoration. Without it, extraction's three feedback
  // jobs — `verify`, `recheck_binding`, `recheck_sampled` — are all the same agent, model and
  // capability, and they run across pages concurrently, so page 1's recheck ending would close
  // page 3's still-open verify and `in_flight` would name the recheck as what the run is stuck
  // on. Adding it strictly narrows the match and cannot make the `i === -1` fallback newly
  // reachable: a start and its end spread the same `meta`, so within one run both carry `step`
  // or neither does.
  const callKey = (e: LogEvent): string =>
    `${e.agent ?? "?"}|${e.step ?? "?"}|${e.model ?? "?"}|${e.capability ?? "?"}`;
  for (const e of currentRun) {
    if (e.type === "model_call_start") {
      openCalls.push(e);
    } else if (e.type === "model_call") {
      const i = openCalls.findIndex((o) => callKey(o) === callKey(e));
      // Fall back to dropping the oldest open call if no identity match: an end
      // event always closes something, and leaving it open would report a
      // phantom hang.
      openCalls.splice(i === -1 ? 0 : i, 1);
    }
  }
  const oldestOpenAt = openCalls.map((c) => c.ts ?? "").sort()[0] ?? null;

  // Whether this run is still working, which is not the same as whether the session is
  // still `running`. A feedback round marks the session `ready_for_review` as soon as the
  // document is delivered and then trains the page agent from it
  // (pipeline/orchestrator.ts), holding its `max_concurrent_runs` slot throughout. Both
  // questions this drives — how long the run has been going, and whether a call is still
  // open — answered "it is over" in exactly that window, which is where a hung provider
  // call delays every upload behind it and nothing else reports it.
  //
  // A dead process is the hard case, because nothing it left behind says it died. For a
  // run interrupted while the session still read `running` or `queued`, the next boot
  // rewrites the status (store/db.ts `failStaleSessions`) and the first clause closes.
  // That sweep does NOT touch `ready_for_review` rows — the document is delivered and the
  // status is correct — so a process killed inside the post-delivery window leaves a row
  // no one will ever correct, and "no terminal line" alone would report its abandoned
  // call as hanging forever, with `waiting_ms` and `elapsed_ms` climbing off the clock.
  //
  // So the claim is bounded by what a call can actually do: each adapter abandons a
  // stream at an absolute 15-minute ceiling and OpenRouter retries at most three times,
  // which puts the longest a call can legitimately stay open at ~45 minutes. Past an hour
  // an open call is not a slow call, it is a process that is gone — and this reports the
  // run as over, which is what it is.
  const abandoned = oldestOpenAt !== null && ms(oldestOpenAt, nowIso) > MAX_PLAUSIBLE_CALL_MS;
  const active = running || (ctx.status === "ready_for_review" && unfinished && !abandoned);

  // The clock runs to NOW only where something is plausibly still happening. For a
  // `running` session that is the whole of it — a run between two calls is still a run.
  // In the post-delivery window it also has to be RECENT, because that window is the one
  // place a run can end without saying so: a process killed there leaves a round that
  // never terminated and a status no sweep rewrites, so measuring it to `now` has
  // `elapsed_ms` counting up for days, `concurrency_factor` decaying toward zero and the
  // last phase's duration growing without end — an idle, delivered session reading as one
  // that has been working since it was killed.
  //
  // Recency is measured from the last event rather than from an open CALL, because the
  // longest step in this window may not be a model call at all: filing the agent-update
  // issue is a GitHub request (github/issue.ts) with no timeout of its own, and a stalled
  // one holds the run's `max_concurrent_runs` slot while `openCalls` is empty. Keying on
  // an open call would freeze the clock on exactly that run, which is the one still
  // occupying the machine.
  //
  // What it costs: a live run stalled for longer than the ceiling in a step that logs
  // nothing is measured to its last event, so its `elapsed_ms` stops climbing. That is
  // the right way round — past an hour of silence, "the process is gone" is the better
  // guess, and it is the only one that terminates.
  const pending = running || (active && ms(lastEventAt ?? undefined, nowIso) <= MAX_PLAUSIBLE_CALL_MS);
  const endRef = pending ? nowIso : terminal?.ts ?? lastEventAt ?? nowIso;
  // Longest-waiting first (oldest start timestamp).
  openCalls.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  const oldest = openCalls[0];
  // "Is this run stuck on something?" is a question about the RUN, and a run is not over
  // when the session says `ready_for_review`: the document is delivered there, but a
  // feedback round then trains the page agent from it (pipeline/orchestrator.ts), holding
  // its `max_concurrent_runs` slot until that finishes. Gating this on the session status
  // alone therefore blinded the one field that answers the question, in exactly the window
  // where a hung provider call delays every upload behind it and nothing else reports it.
  //
  // Gated on `active` above: the run, not the session status. Reading the file's FIRST
  // terminal event rather than this run's would make that gate dead code, since a
  // feedback round only ever starts on a session whose earlier run already wrote one.
  const inFlight =
    active && oldest
      ? {
          agent: oldest.agent ?? "?",
          step: oldest.step ?? "?",
          model: oldest.model ?? "?",
          provider: oldest.provider ?? "?",
          capability: oldest.capability ?? "?",
          since: oldest.ts ?? nowIso,
          waiting_ms: ms(oldest.ts, nowIso),
        }
      : null;
  const inFlightCount = active ? openCalls.length : 0;

  // Completed model calls (the `model_call` end events carry duration_ms).
  const calls = events.filter((e) => e.type === "model_call");
  const durations = calls.map((c) => c.duration_ms ?? 0);
  const failed = calls.filter((c) => c.ok === false).length;
  const total = durations.reduce((a, b) => a + b, 0);

  // Token totals, and how many calls contributed any. Counted over the same `calls`
  // as the timings, which includes the failed ones: a truncated call paid for a full
  // ceiling of output and a stalled one paid for its prompt, so excluding them would
  // under-report the bill on exactly the documents that cost the most.
  const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, calls_reported: 0 };

  const byAgent: Diagnostics["by_agent"] = {};
  const byStep: Diagnostics["by_step"] = {};
  // One fold, run twice over the same calls under two keys, so `by_agent` and `by_step` cannot
  // disagree about a call: every total in either is the same arithmetic over the same events.
  // Summing `by_step` and summing `by_agent` gives the same seven numbers, which is worth being
  // true by construction — a report that quoted a step's share against a differently-collected
  // whole would be wrong in a way no reader could see.
  const fold = (into: Record<string, CallTotals>, key: string, c: LogEvent): void => {
    const cur =
      into[key] ??
      {
        count: 0,
        total_ms: 0,
        max_ms: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
    cur.count += 1;
    cur.total_ms += c.duration_ms ?? 0;
    cur.max_ms = Math.max(cur.max_ms, c.duration_ms ?? 0);
    cur.input_tokens += c.input_tokens ?? 0;
    cur.output_tokens += c.output_tokens ?? 0;
    cur.cache_read_input_tokens += c.cache_read_input_tokens ?? 0;
    cur.cache_creation_input_tokens += c.cache_creation_input_tokens ?? 0;
    into[key] = cur;
  };
  for (const c of calls) {
    fold(byAgent, c.agent ?? "?", c);
    // `?` for a call whose line carries no step, which today means a log written before
    // `step` existed: the router requires one and the type is closed, so a live run cannot
    // produce it. Named rather than dropped — a bucket that silently omitted those calls
    // would make `by_step` sum to less than `tokens` on an old log and say nothing about why.
    fold(byStep, c.step ?? "?", c);

    const reported =
      c.input_tokens != null ||
      c.output_tokens != null ||
      c.cache_read_input_tokens != null ||
      c.cache_creation_input_tokens != null;
    if (reported) tokens.calls_reported += 1;
    tokens.input += c.input_tokens ?? 0;
    tokens.output += c.output_tokens ?? 0;
    tokens.cache_read += c.cache_read_input_tokens ?? 0;
    tokens.cache_write += c.cache_creation_input_tokens ?? 0;
  }

  const slowest = [...calls]
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
    .slice(0, 5)
    .map((c) => ({
      agent: c.agent ?? "?",
      // The step too, because the five slowest calls are where a reader goes to ask what a
      // long run was waiting on, and the agent name does not answer it: a slow `copy_editor`
      // call is a review round or a table join, and those have different remedies.
      step: c.step ?? "?",
      model: c.model ?? "?",
      capability: c.capability ?? "?",
      duration_ms: c.duration_ms ?? 0,
      ok: c.ok !== false,
    }));

  // Phase durations from explicit `phase` events (diff to next, last to end).
  const phaseEvents = events.filter((e) => e.type === "phase" && e.phase);
  const phaseDurations: Record<string, number> = {};
  for (let i = 0; i < phaseEvents.length; i++) {
    const cur = phaseEvents[i];
    const next = phaseEvents[i + 1];
    phaseDurations[cur.phase as string] = ms(cur.ts, next ? next.ts : endRef);
  }

  // The two post-delivery steps report their own failures rather than raising, because
  // neither may revoke a document the user already has (pipeline/orchestrator.ts). That
  // makes them invisible to the `ok === false` rule, which only sees model calls: the
  // throw those catches exist for is an fs read, not a provider error, so a run whose
  // training or contribution died would read as clean here and be findable only in the
  // raw ndjson.
  //
  // Failures, and only failures. `ok === false` was written for `model_call`, where it means
  // the provider refused — but `page_correction_recheck` carries an `ok` of its own meaning
  // "the verifier named no problem", and a second verdict that names one is a measurement
  // coming back negative, not a run that went wrong: the sampled kind runs AFTER the
  // correction is kept and changes nothing about what ships, and the binding kind's refusal
  // is the loop protecting a page that had already passed (`page_links_correction_rejected`).
  // Both were landing here, and 31 of 31 on disk across 22 rounds were the sampled kind — so
  // on a four-document round, two documents that were clean read as having errors and the
  // only thing distinguishing a working measurement from a truncated call was that the
  // measurement's `message` said `"unknown"`, this event carrying its diagnosis under
  // `problems` (issue #296). Excluded here and reported where its counts already are, as
  // `verification.rechecks.failures`, because a non-empty `errors` is the first thing read
  // off a run and it has to mean the run is in doubt.
  const errors = events
    .filter(
      (e) =>
        e.type === "run_failed" ||
        e.type === "feedback_training_failed" ||
        e.type === "contribution_failed" ||
        (e.ok === false && e.type !== "page_correction_recheck"),
    )
    // Every event that reaches here today carries `error`: the three named above are built
    // from a caught throw, and a failed `model_call` is logged by providers/index.ts with the
    // provider's message. So `"unknown"` is what an old log or a future `ok: false` event
    // would read as, and not — as of #296 — a standing entry on every run that sampled.
    .map((e) => ({ ts: e.ts ?? null, type: e.type ?? "error", message: e.error ?? "unknown" }));

  // Which pages the document has no content for — a set, and a set that changes over
  // the life of one session's log, because a feedback round can re-extract a page that
  // failed earlier and fill the hole. So this is a fold over the events in order rather
  // than a filter: `page_extraction_failed` adds, `page_recovered` removes, and what the
  // log says LAST about a page is what is true of the document.
  //
  // `kept: "prior"` is excluded, because that event reports the opposite outcome under
  // the same name: a re-extraction that threw left the page's earlier content in place,
  // so the document is whole and naming the page here would send a client looking for a
  // hole that isn't there (pipeline/extraction.ts reExtractPages). Which is also why a
  // recovered page stays recovered: after the hole is filled, the page HAS content, so
  // every later failure on it is one of these.
  // The verify/correct tally. A fold over the events rather than four filters, so a
  // `page_corrected` line with a `result` this predates counts as a correction and lands
  // in none of the buckets — which is the honest reading of an old log, and better than
  // silently attributing it to one.
  const verification: Diagnostics["verification"] = {
    pages_verified: 0,
    pages_unjudged: 0,
    pages_skipped_blank: 0,
    verify_failed: 0,
    verify_kinds: {
      content_missing: 0,
      content_wrong: 0,
      structure_wrong: 0,
      a11y_only: 0,
      alt_quality: 0,
      untagged_pages: 0,
    },
    verify_untagged_problems: 0,
    verify_inconsistent: {
      pages: 0,
      content_missing: 0,
      content_wrong: 0,
      structure_wrong: 0,
      a11y_only: 0,
      alt_quality: 0,
      content_or_structure: 0,
      undecided_pages: 0,
    },
    corrections: 0,
    results: { kept: 0, rejected: 0, identical: 0, empty: 0, failed: 0 },
    triggers: { verify: 0, links: 0, alt: 0, both: 0 },
    effects: { alt_only: 0, text: 0, attrs: 0, structure: 0, text_grew: 0, text_shrank: 0 },
    rechecks: {
      sampled: 0,
      sampled_ok: 0,
      sampled_unjudged: 0,
      sampled_problems_before: 0,
      sampled_problems_after: 0,
      binding: 0,
      binding_ok: 0,
      binding_unjudged: 0,
      failures: [],
    },
  };
  for (const e of events) {
    if (e.type === "page_verify_ok") {
      verification.pages_verified += 1;
      // Strictly `true`, not truthy: this reader trusts nothing on a log line, and a page
      // whose flag arrived as a string would otherwise be subtracted from the rejection rate
      // on the strength of a typo. A line without the field is a judged page, which is what
      // every log written before it says (issue #211).
      if (e.unjudged === true) verification.pages_unjudged += 1;
      // Strictly the string the emitter writes, and counted inside `unjudged` rather than beside it:
      // a line claiming a skip while claiming a verdict was reached is a line this reader does not
      // have to reconcile, because the only emitter sets both together (pipeline/extraction.ts). A
      // future `skipped` for some other reason lands in `pages_unjudged` and not here, which is the
      // right default — this field is named for the one thing it prices.
      if (e.unjudged === true && e.skipped === "blank") verification.pages_skipped_blank += 1;
    } else if (e.type === "page_verify_failed") {
      verification.pages_verified += 1;
      verification.verify_failed += 1;
      // One page, so each kind it named counts once however many problems carried that kind.
      // Matched against the closed list rather than trusted, for the reason `result` is: a
      // `kinds: ["constructor"]` line would otherwise be added to a function.
      const named: unknown = e.kinds;
      const kinds = Array.isArray(named) ? VERIFY_KINDS.filter((k) => named.includes(k)) : [];
      for (const kind of kinds) verification.verify_kinds[kind] += 1;
      // A page counts as `untagged_pages` when the line named no kind this reader knows — an
      // old log, an agent file whose contract predates the kinds, a model that answered in
      // plain strings — and ALSO when it named some and left others untagged, because then the
      // kind buckets are missing part of that page's story. Unlike the recheck sums below, an
      // absent field is not left alone here: a page in `verify_failed` and in no bucket is
      // exactly what this count exists to make visible, and silence would read as a split
      // that covered the whole run.
      const untagged = typeof e.untagged === "number" && e.untagged > 0 ? e.untagged : 0;
      if (kinds.length === 0 || untagged > 0) {
        verification.verify_kinds.untagged_pages += 1;
      }
      // And the problem count beside it, because the page count alone cannot tell a run where
      // one problem per page arrived untagged from one where every problem did — both report
      // the same `untagged_pages`, and only the second means the split is uninformative. A log
      // that predates the kinds carries no count, and on it every problem the line lists is
      // untagged by definition, so the line's own `problems` supplies the number; a page with
      // neither field readable counts as one, because it is in `verify_failed` and reporting
      // zero would read as fully tagged.
      if (untagged > 0) verification.verify_untagged_problems += untagged;
      else if (kinds.length === 0) {
        verification.verify_untagged_problems += Array.isArray(e.problems) ? Math.max(e.problems.length, 1) : 1;
      }
    } else if (e.type === "page_verify_inconsistent") {
      // NOT added to `pages_verified`: the page that wrote this line also wrote a
      // `page_verify_ok` line, which is where it is counted. This is a second reading of the
      // same verdict, so folding it as a page would count that page twice and make the
      // rejection rate's denominator larger than the run's page count.
      verification.verify_inconsistent.pages += 1;
      // Same closed list and the same reasons as the failure fold above: a kind is counted
      // only if this code knows it, and a page counts once per kind however many problems
      // carried it.
      const named: unknown = e.kinds;
      const kinds = Array.isArray(named) ? VERIFY_KINDS.filter((k) => named.includes(k)) : [];
      for (const kind of kinds) verification.verify_inconsistent[kind] += 1;
      // The pricing field: one per PAGE naming at least one of the three, not one per kind, so
      // it can be read against `pages` as a share and against `corrections` as a bill.
      const decided = kinds.some(
        (k) => k === "content_missing" || k === "content_wrong" || k === "structure_wrong",
      );
      if (decided) verification.verify_inconsistent.content_or_structure += 1;
      // And the unknown above it, which is why this is not the `||` the failure fold uses: a
      // page already naming one of those three is DECIDED, whatever else it left untagged, so
      // counting it here too would double it in a sum whose two halves are meant to bracket the
      // bill. What is undecided is a page carrying a problem with no kind this code knows —
      // including a page whose only tags are `a11y_only` or `alt_quality`, since the untagged
      // one beside them could be anything — and a line with no readable count at all, which is
      // every verdict written in plain prose and the whole of the corpus this was measured on.
      const untagged = typeof e.untagged === "number" && e.untagged > 0 ? e.untagged : 0;
      if (!decided && (untagged > 0 || kinds.length === 0)) {
        verification.verify_inconsistent.undecided_pages += 1;
      }
    } else if (e.type === "page_corrected") {
      verification.corrections += 1;
      // Matched against a fixed list rather than tested with `in`, which answers true
      // for anything on Object.prototype: a log line reading `result: "constructor"`
      // would otherwise be added to a function and turn a count into NaN. The same trap
      // util/html.ts uses a null prototype for.
      const result = CORRECTION_RESULTS.find((r) => r === e.result);
      if (result) verification.results[result] += 1;
      const trigger = CORRECTION_TRIGGERS.find((t) => t === e.trigger);
      if (trigger) verification.triggers[trigger] += 1;
      if (e.text_changed === true) verification.effects.text += 1;
      // The direction, gated on `text_changed` rather than on the two sizes alone: a
      // correction that swaps one word for a longer one changes the prose and its length, and
      // a correction that reorders a sentence changes the prose and not its length, and only
      // the flag knows which happened. Both numbers must be present — an old log carries
      // neither, and `undefined > undefined` is false, so such a line lands in `text` and in
      // neither direction, which is the same reading an unknown `result` gets.
      if (
        e.text_changed === true &&
        typeof e.text_chars_before === "number" &&
        typeof e.text_chars_after === "number"
      ) {
        if (e.text_chars_after > e.text_chars_before) verification.effects.text_grew += 1;
        else if (e.text_chars_after < e.text_chars_before) verification.effects.text_shrank += 1;
      }
      if (e.attrs_changed === true) verification.effects.attrs += 1;
      if (e.structure_changed === true) verification.effects.structure += 1;
      if (
        e.alt_changed === true &&
        e.text_changed !== true &&
        e.attrs_changed !== true &&
        e.structure_changed !== true
      ) {
        verification.effects.alt_only += 1;
      }
    } else if (e.type === "page_correction_recheck") {
      // Split on the flag the event already carries. A line whose `binding` is neither
      // boolean lands in neither bucket, for the same reason an unknown `result` does:
      // guessing which population a verdict belongs to is worse than a total that is
      // visibly short of the lines in the log.
      // Strictly `true`, as on `page_verify_ok`: a recheck subtracted from the pass rate on
      // the strength of a string would be the trap the closed lists here exist for.
      const unjudged = e.unjudged === true;
      // The verdict's own words, kept whichever population the line claims — including a line
      // whose `binding` is neither boolean, which the split below counts in neither: what that
      // line failed to say is which rate it belongs in, not what is wrong with the page. This
      // is the only place in this file the prose survives, and it used to be in `errors` under
      // the word `"unknown"` (issue #296, and see the comment on the field).
      //
      // `ok === false` and strictly so, for the reason every flag here is read strictly. It is
      // also the whole condition: `problems` non-empty is implied by it (extraction.ts
      // `failedCheck`), so there is no second test for an empty message to write.
      if (e.ok === false) {
        verification.rechecks.failures.push({
          ts: e.ts ?? null,
          page: typeof e.page === "number" ? e.page : null,
          binding: typeof e.binding === "boolean" ? e.binding : null,
          message: verdictMessage(e),
        });
      }
      if (e.binding === true) {
        verification.rechecks.binding += 1;
        if (e.ok === true) verification.rechecks.binding_ok += 1;
        if (unjudged) verification.rechecks.binding_unjudged += 1;
      } else if (e.binding === false) {
        verification.rechecks.sampled += 1;
        if (e.ok === true) verification.rechecks.sampled_ok += 1;
        if (unjudged) verification.rechecks.sampled_unjudged += 1;
        // Only when the line carries both, so a log from before these existed leaves the two
        // sums alone rather than adding a zero to each. A missing `problems_before` counted as
        // 0 would read as a page corrected for no reason, which is the opposite of what
        // happened, and it would make the pair say the corrections had nothing to fix.
        //
        // And only when something judged it, for the mirror-image reason: an unjudged sample
        // (the first verdict was real and failed, the second reply would not parse) carries a
        // true before-count and an `problems_after` of 0 that means "nothing was named", not
        // "nothing was left" — a page nobody looked at, summed in as a correction that fixed
        // everything it was handed.
        if (
          !unjudged &&
          typeof e.problems_before === "number" &&
          typeof e.problems_after === "number"
        ) {
          verification.rechecks.sampled_problems_before += e.problems_before;
          verification.rechecks.sampled_problems_after += e.problems_after;
        }
      }
    }
  }

  const failedSet = new Set<number>();
  // Blank pages fold the same way and for the same reason: feedback can name a page the
  // agent reported empty ("you missed the table on page 4"), and a re-extraction that
  // finds content there means the page is not blank after all. So `reextract_start`
  // withdraws the earlier answer for the pages it is about to redo, and the `page_blank`
  // lines that follow it — written by extractPage, before the round's completion line —
  // give the new one. A page that comes back blank again is added straight back.
  //
  // `staleBlank` covers the one path that produces no new answer: a re-extraction that
  // THROWS keeps the page's prior fragment (pipeline/extraction.ts reExtractPages), which
  // for a blank page is the empty one, so the page is still blank and the withdrawal has
  // to be undone. Without it that page would appear in neither set while having no
  // content, which is the reading this whole field exists to prevent.
  //
  // That re-add is made on every throw, including a round where the reply was unreadable —
  // so the last thing the log knows about the page is that the model gave up, and this still
  // says blank. Deliberate, and the least wrong of the cheap answers: the field describes the
  // DOCUMENT, whose fragment for that page is the empty one an accepted declaration produced,
  // and moving the page to `pages_failed` instead would send a client looking for a
  // `@page-failed` marker that is not in the body. The round's own account is in the log
  // (`page_no_output`, `page_extraction_failed` with `kept: "prior"`).
  const blankSet = new Set<number>();
  let staleBlank = new Set<number>();
  for (const e of events) {
    if (e.type === "page_extraction_failed" && typeof e.page === "number" && e.kept !== "prior") {
      failedSet.add(e.page);
    } else if (e.type === "page_recovered" && Array.isArray(e.pages)) {
      for (const p of e.pages) if (typeof p === "number") failedSet.delete(p);
    }
    if (e.type === "page_blank" && typeof e.page === "number") {
      blankSet.add(e.page);
    } else if (e.type === "reextract_start" && Array.isArray(e.pages)) {
      staleBlank = new Set(e.pages.filter((p): p is number => typeof p === "number" && blankSet.has(p)));
      for (const p of staleBlank) blankSet.delete(p);
    } else if (
      e.type === "page_extraction_failed" &&
      e.kept === "prior" &&
      typeof e.page === "number" &&
      staleBlank.has(e.page)
    ) {
      blankSet.add(e.page);
    }
  }
  const pagesFailed = [...failedSet].sort((a, b) => a - b);
  const pagesBlank = [...blankSet].sort((a, b) => a - b);

  // The Copy Editor's fidelity observations, summed over every round it ran — one line per round
  // that had any, so a document reviewed in three rounds can contribute three lines about the same
  // page. `observed` counts observations and `pages` the distinct pages they name, which is what
  // separates one page reported three times from three pages reported once; the same page in two
  // rounds is one page here and two observations, and that is the honest reading of it (the round
  // that produced each is in the log).
  const observed: Diagnostics["fidelity_observed"] = {
    observed: 0,
    pages: [],
    unattached_pages: [],
    kinds: { content_missing: 0, content_wrong: 0, structure_wrong: 0, a11y_only: 0, alt_quality: 0, untagged: 0 },
    unattached: 0,
    unplaced: 0,
  };
  const observedPages = new Set<number>();
  const unattachedPages = new Set<number>();
  for (const e of events) {
    if (e.type !== "editor_fidelity_observed" || !Array.isArray(e.observations)) continue;
    observed.unattached += typeof e.unattached === "number" ? e.unattached : 0;
    observed.unplaced += typeof e.unplaced === "number" ? e.unplaced : 0;
    // Which pages the editor actually had. Read per line rather than unioned across the run,
    // because the attachment is per round: page 4 attached in round 1 and not in round 2 makes an
    // observation filed in round 2 a guess, and unioning would launder it into a checkable one.
    // A line with no `attached` at all leaves every page unnamed here rather than naming them
    // all — there is nothing to tell against, and the count on that line is what says how many
    // were guesses.
    const attached = Array.isArray(e.attached) ? e.attached : null;
    for (const entry of e.observations) {
      if (entry === null || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      observed.observed += 1;
      if (typeof rec.page === "number") {
        observedPages.add(rec.page);
        if (attached !== null && !attached.includes(rec.page)) unattachedPages.add(rec.page);
      }
      // The closed list again, for the reason `verify_kinds` uses it: a `kind` naming a
      // function on Object.prototype would otherwise be incremented rather than counted as
      // the unrecognized label it is.
      const kind = VERIFY_KINDS.find((k) => k === rec.kind);
      if (kind) observed.kinds[kind] += 1;
      else observed.kinds.untagged += 1;
    }
  }
  observed.pages = [...observedPages].sort((a, b) => a - b);
  observed.unattached_pages = [...unattachedPages].sort((a, b) => a - b);

  const elapsed = ms(startedAt ?? undefined, endRef);

  return {
    session_id: ctx.sessionId,
    status: ctx.status,
    phase: ctx.phase,
    started_at: startedAt,
    last_event_at: lastEventAt,
    elapsed_ms: elapsed,
    in_flight: inFlight,
    in_flight_count: inFlightCount,
    phase_durations_ms: phaseDurations,
    model_calls: {
      count: calls.length,
      failed,
      total_ms: total,
      avg_ms: calls.length ? Math.round(total / calls.length) : 0,
      max_ms: durations.length ? Math.max(...durations) : 0,
      concurrency_factor: elapsed > 0 ? Math.round((total / elapsed) * 100) / 100 : 0,
    },
    tokens,
    by_agent: byAgent,
    by_step: byStep,
    slowest_calls: slowest,
    errors,
    verification,
    pages_failed: pagesFailed,
    pages_blank: pagesBlank,
    fidelity_observed: observed,
  };
}
