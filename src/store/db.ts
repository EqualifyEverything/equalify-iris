import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SessionStatus = "queued" | "running" | "ready_for_review" | "closed" | "failed";
// The phases the pipeline actually enters, in order. "triage" and
// "reconciliation" were removed: neither is implemented (nothing writes triage
// notes, and reconciliation cannot run while extraction hardcodes `edges: []`),
// so a client that switched on them was branching on states it would never see.
// A new session starts at "extraction" rather than "triage" for the same reason
// — it used to report a phase for the length of one INSERT, until runPipeline
// immediately overwrote it. See #30 Tier 4 for the decision to build or drop
// each phase; this only stops the enum from claiming they exist today.
export type Phase = "extraction" | "assembly" | "review" | "done";

// No `github_token` field, deliberately. The user's GitHub token is a live
// credential — it files issues on their behalf during a run (§7.13) — but it never
// needs to OUTLIVE the request that carried it: it arrives in the `Authorization`
// header, is passed in memory to the queued run, and is gone when the run ends.
// Storing it made a copy of `data/iris.sqlite` equivalent to GitHub API access as
// every user who had ever logged in, in exchange for nothing the service used.
export interface UserRecord {
  github_user_id: number;
  github_login: string;
  max_review_iterations: number;
  created_at: string;
}

export interface SessionRecord {
  session_id: string;
  github_user_id: number;
  status: SessionStatus;
  phase: Phase;
  iterations_completed: number;
  iterations_max: number;
  image_count: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  // When this session FIRST reached ready_for_review, or null if it never has.
  // Written once, by the store, and never cleared (see writeSet) — which is the
  // whole point: it is what `publicStats` counts, and a public "pages processed"
  // tally that can go DOWN is worse than no tally. `status` cannot answer the
  // question, because a feedback re-run moves a finished session back to
  // `queued` and then possibly to `failed`; counting on status alone would make
  // the public number dip every time someone asked Iris to try again.
  first_completed_at: string | null;
}

// What a caller may change about a session. `first_completed_at` is omitted
// alongside the immutable identity/creation fields: it is derived from the
// status transition itself, so no handler needs to (or gets to) set it by hand.
export type SessionPatch = Partial<
  Omit<SessionRecord, "session_id" | "github_user_id" | "created_at" | "first_completed_at">
>;

// The sort key `GET /v1/sessions` pages on. Both halves are required: session
// rows are ordered by `created_at DESC`, and `created_at` is a millisecond
// ISO-8601 string, so two sessions created in the same millisecond are
// indistinguishable by it. Ties are broken by `session_id DESC` — arbitrary but
// TOTAL, which is what keyset pagination needs.
export interface SessionCursor {
  created_at: string;
  session_id: string;
}

// Cursors are line-noise to a client but deliberately readable in a log:
// "2026-05-22T18:00:00.000Z|ses_01HXYZ…". No base64 wrapper, because an opaque
// blob makes a paging bug unreadable from a request log without buying any real
// encapsulation — the shape is documented either way.
const CURSOR_SEP = "|";

export function encodeCursor(s: SessionCursor): string {
  return `${s.created_at}${CURSOR_SEP}${s.session_id}`;
}

/**
 * Parse a client-supplied cursor, or return null if it is not one.
 *
 * Two behaviors worth stating:
 *
 *   * A cursor with no separator is treated as a bare `created_at` with an empty
 *     id. That is exactly the shape this endpoint issued before the compound
 *     cursor existed, and it degrades to the old `created_at < ?` predicate
 *     (nothing sorts below the empty string, so the tie-breaking clause is
 *     unsatisfiable). A client mid-pagination across a deploy keeps working —
 *     but note what "keeps working" means: that one request still skips the rows
 *     tied on its timestamp, which is the very bug the compound cursor exists to
 *     fix. It is accepted anyway because the alternative is a 400 that breaks the
 *     client outright, and it is self-clearing: the cursor handed back is
 *     compound. Documented in docs/API.md §8 so a gap reported during an upgrade
 *     window is diagnosable rather than mysterious.
 *   * The timestamp half must be in EXACTLY the format the column stores —
 *     `Date#toISOString()`, UTC with milliseconds — not merely something
 *     `Date.parse` accepts. It is bound into a **string** comparison, so the only
 *     question that matters is whether it is comparable to the stored values, and
 *     "parses as a date" is a much weaker predicate than that. `"9999"`,
 *     `"Dec 2026"`, and even the legitimate ISO forms `"2026-05-22T18:00:00Z"`
 *     (no milliseconds) and `"2026-05-22T19:00:00.000+01:00"` (an offset instead
 *     of Z) all parse, and all sort ABOVE every stored `"2026-…"` value — which
 *     reproduces the exact bug the compound cursor exists to fix: the query
 *     matches every row and hands back page one, so a client looping on
 *     `next_cursor` pages forever. The last two are not adversarial input; they
 *     are what a client that reformats a timestamp produces. Rejecting them is a
 *     400 that says what is wrong, rather than a 200 that quietly lies.
 *
 *     Round-tripping through `toISOString()` is the check, because that is
 *     literally the function that produced the stored value (see createSession).
 *     Cursors this endpoint issued before the compound form existed were bare
 *     `created_at` values from the same call, so they still pass.
 */
export function parseCursor(raw: string): SessionCursor | null {
  const i = raw.indexOf(CURSOR_SEP);
  const created_at = i === -1 ? raw : raw.slice(0, i);
  const session_id = i === -1 ? "" : raw.slice(i + 1);
  if (!created_at) return null;
  const t = new Date(created_at);
  if (Number.isNaN(t.getTime()) || t.toISOString() !== created_at) return null;
  return { created_at, session_id };
}

/**
 * Turn an over-fetched result set into one page plus the cursor that follows it.
 *
 * Callers ask `listSessions` for `limit + 1` rows and pass the result here. The
 * extra row is the entire mechanism: it is what distinguishes "the page is full
 * and there is more" from "the page is full and that was everything". Emitting a
 * cursor in the second case costs every client one guaranteed-empty request per
 * list, and a client that treats a non-null cursor as "more exists" reports a
 * page that isn't there.
 *
 * This lives beside the query rather than in the route because the two halves are
 * one contract — the over-fetch, the slice, and the cursor have to agree, and a
 * route that re-derives them can drift from the query silently.
 *
 * `limit` is clamped here as well as at the route, because a negative one is
 * quietly destructive at both ends: SQLite treats `LIMIT -4` as NO limit (it
 * reads the user's entire session table), and `rows.slice(0, -5)` drops rows off
 * the END of the page while still leaving `rows.length > limit` true — so the
 * response is a short page with a non-null cursor, the one combination that tells
 * a client "there is more" about rows it was never shown.
 */
export function pageSessions(
  rows: SessionRecord[],
  limit: number,
): { page: SessionRecord[]; next: SessionCursor | null } {
  const size = Math.max(1, Math.floor(limit) || 1);
  const page = rows.slice(0, size);
  const held = rows.length > size ? page[page.length - 1] : null;
  return {
    page,
    next: held ? { created_at: held.created_at, session_id: held.session_id } : null,
  };
}

// The signals Iris records about its own output, as opposed to the axe-core rule
// ids that share the `run_signals.code` column (PRD §7.16). Prefixed so the two
// namespaces cannot collide — axe adds rules between versions, and a new rule
// named `rounds` would otherwise be counted as a measurement of ours.
//
// Constants rather than inline strings because the recorder, the aggregate query
// and the tests must all spell them identically, and the failure mode of a typo is
// silent: a rate that reads 0% forever, which is indistinguishable from the good
// news it would be mistaken for.
//
// `iris:rounds` is recorded for EVERY delivered document, including a flawless one.
// That is what makes it the denominator: a clean run produces no rule rows and no
// unresolved row, so counting documents by "has any signal" would have divided by
// the problem documents alone and reported every rate as ~100%.
export const SIGNAL_ROUNDS = "iris:rounds";
// How many issues the review loop still had open when it stopped — at its iteration
// cap, on a round that changed nothing, or on a round whose response hit the output
// ceiling (pipeline/review.ts). That last one is recorded here AS WELL AS under
// SIGNAL_EDITOR_TRUNCATED, from independent spreads: the two are not alternatives, so
// a truncated document is in this numerator too. Recorded only when non-zero. Needed as its own signal because the round count cannot answer this:
// `iterations_completed = iterations_max` is equally what a document that came back
// clean on the very last permitted round looks like, and since the loop can also stop
// early, a LOW round count no longer implies a document that needed little fixing.
export const SIGNAL_UNRESOLVED = "iris:unresolved";
// How many hrefs the Copy Editor dropped while rewriting. Unrecoverable content
// loss (the href came from the source FILE, not the page image), invisible to every
// later check in the loop, and previously only a line in one session's log.
export const SIGNAL_LINKS_DROPPED = "iris:links-dropped";
// How many in-document references in the delivered document do not land — `href="#"`, or a
// fragment naming an id the document does not contain (#234). Recorded only when non-zero.
//
// Not a subset of anything else here, and not visible in any of it. axe has no rule for a
// same-document reference that resolves to nothing, `duplicate-id` cannot fire because
// anchors.ts already removed the collisions, `links_dropped_rate` is about absolute URLs
// leaving the document, and the anchors report only ever names a reference at least one page
// claims — so a document whose whole table of contents is dead lints clean, reports
// `ambiguous: []`, and ships as `ready_for_review`. A count of 82 of 226 links in one bench
// round is what this signal exists to stop being invisible.
//
// Per REFERENCE, not per distinct dead id: one missing section linked forty times is forty
// references a reader can activate to no effect, and 82-of-226 is the reading the count has
// to support. (The distinct ids are on the run's `internal_links` line, capped at 20, and
// stay on the deployment — a fragment is text chosen out of the document.) The rate below
// then reduces this to one document, as every rate here does.
export const SIGNAL_LINKS_UNRESOLVED = "iris:links-unresolved";
// The delivered document's own markup does not balance: some element whose end tag HTML
// REQUIRES has a different number of start and end tags (#240). One per element name, not per
// missing tag, and recorded only when something is off.
//
// Unreachable by the lint gate, and not by omission — axe lints a parsed DOM, and the parser's
// job is to make malformed markup well-formed before axe sees it. A bench document delivered
// with `table 16/15` reached axe as sixteen tidy tables and returned zero violations. This is
// the one check that has to run on the BYTES, because that is the only place the evidence
// still exists.
//
// What it means for a reader depends on the element, which is why the log line names it and
// this count does not pretend to: the parser's recovery from an unclosed `<table>` costs
// nothing at all, while an unclosed `<a>` swallows every word up to the next link into its
// anchor text. Either way the document the model believes it wrote and the document a browser
// builds are not the same document, and nothing else here would say so.
export const SIGNAL_MARKUP_UNBALANCED = "iris:markup-unbalanced";
// Tables in the delivered document that hold no row a reader receives as content (#240) —
// announced to a screen-reader user by caption and column headers, with nothing in them.
//
// "No content row" rather than "a header block and no body", because the defect is what the
// reader gets and it arrives in more than one shape: no rows at all, no row outside a declared
// `<thead>`, or — where the model declared no header block — no row that is anything but column
// headers, which is what the parser leaves when a bare `<tr><th scope="col">` becomes the
// implicit body. A table whose body cells are all `<th scope="row">` is content and is not
// counted.
//
// Measured on the PARSED tree, unlike the signal above, because this is a question about what
// a reader receives and the parser's recovery is part of that. 1 of 48 tables in one bench
// round, in the same document as the unbalanced tag: the continued header block of a table
// split across three pieces was emitted twice and one copy got no body.
//
// axe has no rule for it (`empty-table-header` is about a header cell with no text), and it
// cannot be inferred from anything else recorded here: the data was not lost, the split halves
// are both present, and the document lints clean.
export const SIGNAL_TABLE_NO_BODY = "iris:table-no-body";
// Structural promises the delivered document does not keep, which a script can prove without a
// model reading it (#255): a reference to an id the document does not contain, a term list whose
// terms have no definitions, and a landmark announced with nothing in it.
//
// One signal for three checks, and per INSTANCE, for the same reason as SIGNAL_LINKS_UNRESOLVED
// above: the rate answers one question — did this document ship promising a reader something that
// is not there — and which of the three it was is a diagnosis a maintainer reads on the run's
// `delivered_structure` line, where the offending elements are named too.
//
// None of the three is reachable from anything else in this table, and each escapes the lint gate
// differently: axe reports a dangling `aria-labelledby`/`aria-describedby` as `incomplete` and
// never as a violation (`aria-valid-attr-value` is `reviewOnFail`), `<dl><div><dt>Term</dt></div>
// </dl>` passes `definition-list` outright because the wrapping `<div>` is legal HTML, and an
// empty `<nav>` breaks no rule at all. So all three ship as `ready_for_review` on a clean lint.
//
// A language tag on an element with no text for it to apply to is measured beside these three and
// deliberately NOT counted here: it is wasted output rather than something a reader loses, and
// folding it in would move a rate that is otherwise about harm. Its incidence stays on the log
// line.
export const SIGNAL_STRUCTURAL_DEFECT = "iris:structural-defect";
// axe-core failed to run at all. Recorded because a linter that did not run reports no
// violations, so without this signal a broken linter would quietly drive every
// accessibility rate in this table to zero and read as a fixed deployment. It is also
// what `documents_linted` is derived from, i.e. what keeps those rates' denominator
// meaning "documents this was actually measured on" (#164).
export const SIGNAL_LINT_ERROR = "iris:lint-error";
// WHICH of the three steps failed, recorded beside the signal above rather than instead of
// it: `lint_error_rate` keeps its meaning and its threshold, and this says whether the next
// occurrence is a cause already fixed or a new one.
//
// It is a separate signal because the run log is the only other place the step is written
// down, and a run log cannot be read to answer a question about the deployment: it belongs
// to one session, and the sessions here are user uploads (at the reference deployment,
// student records). #263 was filed on 6 documents with no verdict, and answering "is this
// the digit-leading attribute name that #257 fixed, or something else" meant reading six
// people's documents — so it could not be answered at all, which is how a fixed cause and a
// live one come to look identical in a weekly report.
//
// The vocabulary is closed and comes from `LintResult.errorWhere`: three fixed strings, so
// nothing here can carry text out of a document, which is the constraint on everything this
// table feeds (see QualityStats). Derived rather than written out as three constants for the
// reason the block above gives for using constants at all — the recorder and the aggregate
// query must spell them identically, and one function is the strongest way to say so.
export const LINT_ERROR_WHERE = ["parse", "inject", "run"] as const;
export type LintErrorWhere = (typeof LINT_ERROR_WHERE)[number];
export function lintErrorWhereSignal(where: LintErrorWhere): string {
  return `${SIGNAL_LINT_ERROR}-${where}`;
}
// A correction round's response hit the model's output token ceiling (issue #143).
// Recorded because the cost of it is invisible in every other rate here: the document
// ships, its issues go into `iris:unresolved` exactly like issues the editor tried and
// failed to fix, and the one thing that distinguishes them — a whole document's worth of
// output paid for and discarded — would be a line in one session's log.
//
// What it does NOT say, since #165, is that anything was lost. The round is made again a
// section at a time before it is given up on, so this signal fires on a round that came
// back complete by the expensive route as well as on one that came back not at all: of the
// 16 truncations in the bench archive, the 6 from before the sectioned retry existed lost
// their round outright, and of the 10 after it, 9 delivered every section. It is therefore
// a question about the DEPLOYMENT — whether `providers.<name>.max_tokens` fits the
// documents it is being given, or `max_pages` is too high for that ceiling — and the cost
// of taking the long way round, which is a real cost: the section calls were 32.9% of one
// bench round's spend. What a truncation cost the READER of the document is the signal
// below, and the two are separate because a threshold can only be put on the second (#159).
export const SIGNAL_EDITOR_TRUNCATED = "iris:editor-truncated";
// The truncated round did not come back whole: the body could not be sectioned at all, or
// a section truncated in its turn and kept the text it went in with (`correctBySection`).
// Those sections' issues are in the delivered document uncorrected, and no later round
// looks for them again, because a truncation is the loop's last round.
//
// A strict subset of SIGNAL_EDITOR_TRUNCATED above, and of `iris:unresolved` too — a
// truncated round only happens on a document the Reader raised issues about, so every
// document here has an unresolved row as well. It adds no population to this table; what it
// adds is attribution, and that is exactly what it is for. `unresolved_rate` answers "did
// documents ship with issues open" over every cause at once, at a threshold loose enough to
// live with the inherent floor; this answers "did the output ceiling stop the loop from
// trying", whose remedy is one number in the deployment's config rather than a prompt.
export const SIGNAL_EDITOR_TRUNCATED_LOST = "iris:editor-truncated-lost";
// How many windows of the document the review's last read of it came back with no usable
// answer for (issue #186). Recorded only when non-zero, like the three above.
//
// This one is not a cost, it is a hole in the measurement, which is why it changes
// `publicQuality`'s clean count rather than only adding a rate. A document with an
// unreadable read has no `iris:unresolved` row — the reviewer found nothing, because it
// answered nothing — so absence of that row was being read as evidence of cleanliness on
// exactly the documents where there is no evidence either way. It is the same principle as
// SIGNAL_LINT_ERROR one signal up: an absent verdict must not count as a good one.
export const SIGNAL_REVIEW_UNREAD = "iris:review-unread";
// WHY the review loop stopped, recorded for every delivered document and in the same five
// words the loop's own exits are (#264). Beside `iris:unresolved` rather than instead of it,
// for the reason the lint pair above gives: the rate keeps its meaning and this says which
// remedy it is asking for.
//
// It exists because the loop's stopping conditions are not alternatives a reader can weigh —
// they point at three unrelated fixes, and the aggregate could not tell them apart at all.
// `cap` is a budget that ran out, whose remedy is one number in the deployment's config.
// `converged` is the editor having been shown the issues and answered "no change", whose
// remedy is a prompt, and which the loop treats as final ON PURPOSE (see `review_converged`
// in pipeline/review.ts: the next round would be the same request about the same body).
// `truncated` is an output ceiling. Those were previously distinguishable only in a run log,
// i.e. only by reading one user's document — the same wall #263 hit.
//
// Its first use is arithmetic nobody should have to redo: #264 reported
// `unresolved_rate` 0.843 with `mean_rounds` 0.886 against a cap of 3, so the budget was
// going unspent on documents that shipped with issues open, and raising the cap could not
// have helped. That inference is available only because both numbers happened to be in one
// tally; this field makes it a measurement instead.
//
// `clean` is in the vocabulary although `1 - unresolved_rate` almost gives it, and the
// redundancy is the point: with it the five counts sum to `documents`, so a shortfall means
// an exit that recorded nothing. See QualityStats.review_stopped for how to read one.
export const REVIEW_STOPPED = ["clean", "unread", "converged", "truncated", "cap"] as const;
export type ReviewStopped = (typeof REVIEW_STOPPED)[number];
export const SIGNAL_REVIEW_STOPPED = "iris:review-stopped";
export function reviewStoppedSignal(where: ReviewStopped): string {
  return `${SIGNAL_REVIEW_STOPPED}-${where}`;
}
// How the Reader rated the issues that were still open, as a second row per severity on the
// documents `iris:unresolved` counts (#264). The question it answers is the one that issue
// asks and could not answer: whether 84% of documents shipping with something open is 84%
// carrying a barrier, or 84% carrying a nit the loop was right not to churn over.
//
// The vocabulary is closed HERE and not by `ReviewIssue`, which is the whole reason this is a
// function. That type says `"low" | "medium" | "high"`, but nothing enforces it — the issues
// are parsed out of model JSON with a `typeof issue === "object"` check and no field
// validation (pipeline/review.ts) — so the value at runtime is whatever the Reader wrote.
// Publishing it as found would put a model-chosen string in a public issue, which is the one
// thing this table must never do. Anything unrecognised becomes `unrated`, which is also
// where an absent severity lands.
export const UNRESOLVED_SEVERITY = ["high", "medium", "low", "unrated"] as const;
export type UnresolvedSeverity = (typeof UNRESOLVED_SEVERITY)[number];
export function unresolvedSeveritySignal(severity: UnresolvedSeverity): string {
  return `${SIGNAL_UNRESOLVED}-${severity}`;
}
export function unresolvedSeverity(raw: unknown): UnresolvedSeverity {
  const found = UNRESOLVED_SEVERITY.find((s) => s === raw);
  return found && found !== "unrated" ? found : "unrated";
}
// The delivered document still says a page was not returned in full: a
// `[page not fully transcribed]` marker survived into the body (BODY_MARKERS in
// pipeline/review.ts). Recorded per marker, only when there is one.
//
// This is the floor under `unresolved_rate`, and it is a designed-in floor rather than a
// defect. READER_SYSTEM instructs the Reader to report every one of those markers with its
// page, and says in the same paragraph that settling it means re-extracting that page, "which
// is nobody's job in this loop, so it is reported and left standing". So a document carrying
// one CANNOT finish the review loop clean, however many rounds it is given: the Reader will
// raise it again every round, and the editor is forbidden to resolve it.
//
// Recorded because a threshold on `unresolved_rate` is meaningless without it. That rate was
// documented from the start as needing to be "loose enough to live with the inherent floor"
// (see SIGNAL_EDITOR_TRUNCATED_LOST), and the floor had never been measured — so the number
// in the workflow is a guess against an unknown, which is how #264 came to be filed at 0.843
// against 0.15 with no way to tell how much of it was inherent.
export const SIGNAL_UNFINISHED_PAGE = "iris:unfinished-page";

// One measurement about one delivered document. `count` is a magnitude (nodes for a
// rule, issues for `iris:unresolved`, rounds for `iris:rounds`) and is never a
// document-level tally — see the run_signals PRIMARY KEY for why those are separate.
export interface RunSignal {
  code: string;
  impact?: string | null;
  count: number;
}

// What `GET /v1/quality` serves and what the weekly workflow files issues from
// (PRD §7.16).
//
// Every field is a count, a rate or an axe rule id. There is deliberately no field
// that can carry text from a converted document: this feeds an endpoint whose
// consumer copies values into a PUBLIC GitHub issue, and the documents are
// uploaded by users — at the reference deployment, student records. A rule id comes
// from axe's fixed vocabulary; an unresolved-issue description is model-written
// prose about someone's document, which is why only its COUNT is here.
export interface QualityStats {
  window_days: number;
  documents: number;
  since: string | null;
  // Mean EDITOR passes per document — the loop returns as soon as the Reader finds
  // nothing, so a document that reads clean on the first look contributes 0, and 0 is
  // the good value. Low is not only that, and this number cannot tell the cases apart:
  // the loop also stops as soon as a round changes nothing (pipeline/review.ts), so a
  // document whose remaining issues are ones it is designed not to fix contributes a
  // low count too. `null` only when there is nothing to average.
  mean_rounds: number | null;
  // Share of documents (0–1) whose review loop stopped with issues still open — at its
  // iteration cap, on a round that changed nothing, or on a round whose response hit the
  // output ceiling. That last case is counted here too, so this is not disjoint from
  // `editor_truncated_rate` below; it is the superset.
  //
  // Those three are not one measurement, and `review_stopped` below is where they come apart
  // (#264): on the first two the list shipped in `@unresolved` was read on the bytes that were
  // delivered, and on the third it may predate them. A threshold set over the mixture is set
  // over both facts at once.
  unresolved_rate: number;
  // How the Reader rated what was left open, one entry per severity in `UNRESOLVED_SEVERITY`
  // order and ALWAYS all four, zeroes included — the same "measured, and none of these" vs
  // "not measured" distinction `lint_error_where` keeps below. Per DOCUMENT: a document with
  // four low issues and one high is one entry in each of those two, so the counts sum to more
  // than `unresolved_rate × documents` and are not a partition of it.
  //
  // This is the field that decides whether `unresolved_rate` describes a defect. The rate
  // counts documents that shipped with anything open at all, which for a Reader designed to
  // report a nit is a number with no natural ceiling; `high` is the part of it a reader of the
  // document would call a barrier. A threshold belongs on this, not on the rate — but not
  // until there is a window's worth of it to set one from.
  //
  // `unrated` is not a fifth severity, it is the Reader having written something outside the
  // three (or nothing). Read it as measurement noise unless it is large, in which case the
  // Reader's output contract is what to look at, not the review loop.
  unresolved_severity: { severity: UnresolvedSeverity; documents: number }[];
  // Which of the loop's exits ended each document, one entry per value in `REVIEW_STOPPED`
  // order and always all five (#264). Recorded for every delivered document, so unlike
  // `unresolved_severity` above these ARE a partition — of the documents that recorded one,
  // which is every document on a window that postdates the field and fewer than `documents`
  // on any window that does not. The next paragraph is that case, and it is the usual one.
  //
  // A sum BELOW `documents` is the one reading worth spelling out, and it means one of two
  // things. Either the window includes documents delivered before this was recorded — the same
  // shortfall `lint_error_where` can show — or an exit was added to the loop and given no
  // stop reason, which is the failure this field is shaped to make visible rather than
  // guessable. It is never a sixth kind of exit. Whenever the sum is short, this breakdown is
  // about the documents it sums to and NOT about the window: `unresolved_rate` is over
  // `documents`, so quoting the two side by side is quoting two denominators, and the split
  // does not scale up to the rate.
  //
  // `clean` is the good value and the only one the loop reaches by re-reading the finished
  // document and finding nothing. The other four all deliver `@unresolved`, and which one it
  // was is which fix is being asked for: `cap` a config number, `converged` a prompt,
  // `truncated` an output ceiling, `unread` a reviewer that could not read part of what it was
  // judging. See SIGNAL_REVIEW_STOPPED.
  //
  // Which of them the delivered `@unresolved` list is a statement ABOUT is the split #264 asked
  // for, and it is not the same division. The loop re-reads at the TOP of every round
  // (pipeline/review.ts), and `cap`, `converged` and `unread` are all taken before the next
  // editor call — so on those the list was read on the bytes that shipped. `truncated` is the
  // one exit where it may be older than the document: the editor's reply was cut off, the
  // sectioned retry may have corrected part of the body afterwards, and the round that would
  // have re-read it is the one that could not be made. It over-reports on purpose there, and a
  // truncation whose retry rescued nothing over-reports not at all — a distinction this tally
  // cannot draw, and the delivered document can (`@editor-truncated sections N of M`).
  //
  // So `cap` + `converged` is the part of `unresolved_rate` that is a claim about the delivered
  // document, `truncated` is the part that is a claim about the round, and a single threshold
  // over the two cannot be set honestly. `unread` is in neither: its list is empty, so it
  // contributes no `iris:unresolved` row at all (see SIGNAL_REVIEW_UNREAD), which is what makes
  // `cap + converged + truncated` equal the documents in the rate on a fully attributed window.
  review_stopped: { where: ReviewStopped; documents: number }[];
  // Share of documents where the Copy Editor dropped at least one link.
  links_dropped_rate: number;
  // Share of documents delivered with at least one in-document reference that does not land:
  // `href="#"`, or a fragment naming an id the document does not contain (#234). Independent
  // of every other rate here — nothing else in this table, and no axe rule, can see it.
  //
  // Deliberately unthresholded in `.github/workflows/quality-report.yml` for now, and that
  // file says why beside the thresholds it does have: the first round to measure it found 2
  // of 4 documents affected, so a threshold today would file the same issue every week about
  // a defect already tracked in #234. It belongs in the change that fixes the producers.
  links_unresolved_rate: number;
  // Share of documents delivered with markup that does not balance — an element whose end tag
  // HTML requires, with a different number of start and end tags (#240). The one rate here that
  // is about the delivered BYTES rather than the parsed document, and it has to be: an HTML
  // parser repairs malformed markup before axe can see it, so a document with an unclosed
  // `<table>` lints clean. Which element it was is in the run's `delivered_markup` line.
  //
  // Unthresholded, like `links_unresolved_rate` and for the same reason — one document of four
  // in the round that found it, and the producers are what a threshold should follow.
  markup_unbalanced_rate: number;
  // Share of documents delivered with at least one table holding no row a reader receives as
  // content (#240) — announced by caption and column headers with nothing in it. Measured on the
  // parsed tree, because that is what a reader gets. No axe rule covers it, and the captions stay
  // on the deployment: a caption is text out of the user's own document.
  table_no_body_rate: number;
  // Share of documents delivered with at least one structural promise the document does not keep
  // (#255) — a reference to an absent id, a term list with no definitions, or an empty landmark.
  // Three checks under one rate because they fail identically from here: nothing is malformed, so
  // the lint gate returns clean and the run reaches `ready_for_review` anyway. Which class it was,
  // and the elements it was on, are in the run's `delivered_structure` line — as is a language tag
  // on an element with no text, which is measured but is not in this rate (see
  // SIGNAL_STRUCTURAL_DEFECT).
  //
  // Unthresholded, like the two rates above and for the same reason: the first question about a
  // class nothing could see before is how often it fires on a deployment's real traffic.
  structural_defect_rate: number;
  // Share of documents where axe-core could not run.
  lint_error_rate: number;
  // Which step failed on those documents, one entry per step in `LINT_ERROR_WHERE` order and
  // ALWAYS all three of them, including the zeroes. A step is absent from this list only on a
  // deployment too old to record it, so a caller can tell "measured, and none of these" from
  // "not measured" — the same distinction `documents_linted` exists to preserve one field up,
  // and the one #164 was about.
  //
  // `parse` is jsdom refusing the assembled HTML, `inject` is axe's own source failing to
  // evaluate (a dependency problem, which cannot depend on the document), `run` is the rule
  // pass throwing while it walks the document. Those three answers point at three different
  // fixes, which is why the split is worth a field: the one occurrence anybody has diagnosed
  // was a `run` failure from an attribute name the selector engine could not compile (#144,
  // #164, fixed in #257).
  //
  // The counts can sum to LESS than `lint_error_rate × documents` and the shortfall is not an
  // error: a document linted before this was recorded contributes to the rate and to no step.
  // Reading the shortfall as a fourth kind of failure is the one wrong way to use this field.
  lint_error_where: { where: LintErrorWhere; documents: number }[];
  // How many of `documents` the linter actually examined — the rest are the
  // `lint_error_rate` ones, on which there is no verdict at all rather than a clean one
  // (#164). This is the denominator `rules[].share` divides by, and it is reported
  // because without it that share cannot be interpreted: over `documents` it silently
  // counts every unexamined document as one where the rule did not fire, so a run of
  // failing lints makes every rule look like it is being fixed.
  documents_linted: number;
  // Share of documents where a correction round's response hit the output ceiling. A cost
  // and configuration number, not a content one: since #165 the round is re-made a section
  // at a time, so this counts the documents that took the expensive route whether or not it
  // worked. Deliberately unthresholded in `.github/workflows/quality-report.yml`, which says
  // why beside the thresholds it does have (#159).
  editor_truncated_rate: number;
  // Share of documents where that retry did not cover the whole body, so part of the
  // document kept the text it entered the round with and nothing looked at those issues
  // again. A strict subset of `editor_truncated_rate` above and of `unresolved_rate`, and
  // the one of the two truncation numbers a threshold can be put on — the other rises with
  // document length alone.
  editor_truncated_lost_rate: number;
  // Share of documents where part of the reviewer's last read came back unusable, so some
  // of the document has no review verdict at all (#186). Disjoint from nothing: a document
  // here may also be in `unresolved_rate` (the windows that DID answer found issues) or in
  // neither, which is the case this rate exists for — an empty issue list that is silence
  // rather than a clean bill of health. Read it as the error bar on `unresolved_rate`.
  review_unread_rate: number;
  // Share of documents delivered with a `[page not fully transcribed]` marker still in the
  // body, i.e. documents that could not have finished the review loop clean whatever budget
  // they were given (#264). This is the measured floor under `unresolved_rate`, not a defect
  // rate of its own: the Reader is instructed to report every such marker and nothing in the
  // loop is allowed to resolve one, so each of these documents is a guaranteed member of that
  // numerator. Subtract it before asking whether a threshold on the rate is being met.
  //
  // The marker's own cause is upstream of everything this table measures — a page the
  // extractor could not return in full — so a high value here is a question about extraction
  // and `max_pages`, not about review. See SIGNAL_UNFINISHED_PAGE.
  unfinished_page_rate: number;
  rules: {
    id: string;
    impact: string | null;
    documents: number;
    // documents / documents_linted, i.e. "fails on this share of what we ship AND
    // checked". Not over every delivered document: a document axe could not run on
    // cannot fail this rule or pass it, so counting it in the denominator moves the
    // share down by exactly the wrong thing (#164).
    share: number;
    // Total offending nodes across those documents. A rule can be rare but
    // enormous, or ubiquitous and a single node each; the two ranks differently.
    nodes: number;
  }[];
}

// Window `GET /v1/quality` reports over when the caller does not say. Long enough
// that a rate is not one bad afternoon, short enough that it MOVES after a fix —
// an all-time rate is the failure mode to avoid here, since it converges to a
// number that no longer describes the current prompts and cannot fall.
export const DEFAULT_QUALITY_WINDOW_DAYS = 30;
// Refuse to report over a window so short the denominator is a handful of
// documents, or so long it is effectively all-time. Both produce a number that
// looks like a measurement and is not one.
export const MIN_QUALITY_WINDOW_DAYS = 1;
export const MAX_QUALITY_WINDOW_DAYS = 365;

// What `GET /v1/stats` publishes about output quality — the public subset of
// `QualityStats`, and deliberately much less of it.
//
// The difference in audience is the whole design: `/v1/quality` is read by one CI job
// behind a shared secret and may say what is still failing, because its consumer is
// the person who would fix it. This is read by anyone who loads the demo page, so it
// carries two numbers a visitor can actually interpret and no rule ids — a standing
// list of axe rules on a public front page is a to-do list, not a claim about the
// service, and `share` on a small denominator is noise dressed as a measurement.
export interface PublicQuality {
  // Echoed so a client can say "over the last N days" without hardcoding it. Fixed,
  // not caller-chosen: `/v1/stats` takes no parameters and has one shared cache entry.
  window_days: number;
  // Denominator: delivered documents in the window, flawless ones included.
  documents: number;
  // Share (0–1) of those documents the reviewer read in full and finished with nothing left
  // open. Stated the positive way round because this one is read by someone deciding whether
  // to trust Iris with a file — which is also why "read in full" is part of it: it is
  // 1 − (`unresolved_rate` ∪ `review_unread_rate`), not the complement of the first alone.
  // A document part of which the reviewer never answered about has nothing open because
  // nothing was looked for, and that is not what a visitor reads this number as (#186).
  clean_rate: number;
  // Mean editor passes per document. 0 is the good value — the loop stops as soon as
  // the Reader finds nothing, so a document that reads clean immediately contributes
  // 0 — and unlike `QualityStats.mean_rounds` this is never null, because the floor
  // below guarantees a non-zero denominator.
  mean_rounds: number;
}

// Below this many documents in the window, `Store.publicQuality` returns null and the
// public tally says nothing about quality at all.
//
// Two reasons, and the second is the one that makes this a privacy control rather than
// a presentation choice. A rate over three documents is not a measurement: one bad
// afternoon reads as "67% clean" on the front page, and one flawless week reads as
// 100%, and neither describes the prompts. And on a quiet deployment the aggregate IS
// the individual — with a handful of documents in the window, "50% finished clean"
// combined with the same page's document count is a statement about identifiable
// people's uploads, in the reference deployment's case student records. The tally is
// already written to stay silent rather than boast an empty number; this extends that
// to the case where the number exists and still should not be said.
//
// Enforced in the store, not in the route, so it cannot be lost to a future route edit
// that reads the fields it wants — the same reason `qualityStats` never returns text.
export const PUBLIC_QUALITY_MIN_DOCUMENTS = 20;

// The window a request actually gets, from whatever it asked for. Exported because
// `GET /v1/quality` caches by window and has to key on the SAME value the query ran
// under: keying on the unclamped request would let `?days=1000` and `?days=1001` add
// a permanent entry each for one identical 365-day answer, and a second copy of this
// arithmetic in the route is a clamp that can drift from the one that matters.
// A garbled or zero request falls back to the default rather than to the minimum —
// see the route for why a typo must not narrow a weekly job's window to one day.
export function clampQualityWindow(days: unknown): number {
  return Math.min(
    MAX_QUALITY_WINDOW_DAYS,
    Math.max(MIN_QUALITY_WINDOW_DAYS, Math.floor(Number(days)) || DEFAULT_QUALITY_WINDOW_DAYS),
  );
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // BEFORE any DDL or PRAGMA below. Refusing to adopt a file and then writing to
    // it anyway is a contradiction, and the writes are not harmless: the `exec`
    // block drops `idx_sessions_user`, creates its compound replacement, and
    // switches the file to WAL. All three land on a database this then declines,
    // which breaks the one recovery path the error message implies — rolling back to
    // the previous build to export session history before deleting the file, whose
    // `listSessions` pages on the index that is now gone.
    this.rejectLegacyUsersTable(path);
    // busy_timeout is 0 on a fresh node:sqlite connection — "fail immediately",
    // not "wait for the lock". WAL still allows only one writer, so without a
    // timeout a second process's UPDATE against a held write lock throws
    // ERR_SQLITE_ERROR instead of completing. That would break claimSession in
    // the very scenario that justifies it: a loser is supposed to report 0
    // changed rows so the caller can answer 409, and a synchronous throw in a
    // handler is an uncaught exception (there is no error middleware) — a 500.
    // Every write here is a single-statement autocommit, so contention lasts
    // microseconds; 5s is a ceiling for the multi-process case, not a budget.
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      -- No github_token column, and no fork_repo column. The token is never
      -- persisted (see UserRecord above); fork_repo belonged to the fork-and-PR
      -- flow of PRD §7.13, which was never built and is not going to be —
      -- contributions are filed as issues under the user's own identity (§12).
      CREATE TABLE IF NOT EXISTS users (
        github_user_id INTEGER PRIMARY KEY,
        github_login TEXT NOT NULL,
        max_review_iterations INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        github_user_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        iterations_completed INTEGER NOT NULL DEFAULT 0,
        iterations_max INTEGER NOT NULL DEFAULT 3,
        image_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        -- Nullable and write-once; see SessionRecord and addCompletionColumn.
        first_completed_at TEXT
      );
      -- Matches the compound keyset order listSessions pages on, exactly. A new
      -- NAME rather than a redefinition of idx_sessions_user: CREATE INDEX IF NOT
      -- EXISTS is a no-op when the name already exists, so editing the old
      -- statement's columns in place would silently leave every already-deployed
      -- database on the two-column version.
      CREATE INDEX IF NOT EXISTS idx_sessions_user_page
        ON sessions(github_user_id, created_at DESC, session_id DESC);
      -- ...and then drop the two-column index it supersedes. It was a strict
      -- PREFIX of the above, and no query orders on (github_user_id, created_at)
      -- alone any more, so keeping it bought nothing and cost an extra b-tree
      -- write on every session insert. Unconditional and idempotent: this is the
      -- migration step for databases created before the compound cursor.
      DROP INDEX IF EXISTS idx_sessions_user;
      -- What each delivered document cost us in quality terms, one row per signal
      -- (PRD §7.16). See recordRunSignals for what a row means and qualityStats for
      -- what is counted over them.
      --
      -- Needs no ALTER migration, unlike sessions.first_completed_at: this is a new
      -- TABLE, and CREATE TABLE IF NOT EXISTS does create it on an already-deployed
      -- database. An existing deployment simply has no history here, and
      -- qualityStats reports over the window it does have.
      --
      -- The PRIMARY KEY is load-bearing rather than hygienic. It is what makes
      -- "how many documents had this problem" answerable as COUNT(*) GROUP BY code:
      -- at most one row per (document, signal) exists, so a rule firing on forty
      -- nodes of one page cannot look like forty documents. The per-node figure is
      -- kept separately, in the count column.
      CREATE TABLE IF NOT EXISTS run_signals (
        session_id TEXT NOT NULL,
        -- An axe-core rule id ("heading-order"), or one of the SIGNAL_* codes
        -- below, which are "iris:"-prefixed so our own measurements can never
        -- collide with a rule id axe adds in a future version.
        code TEXT NOT NULL,
        impact TEXT,
        count INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (session_id, code)
      ) WITHOUT ROWID;
      -- Every read is windowed on recorded_at (see qualityStats), and this table
      -- gets several rows per document where the sessions table gets one — so
      -- unlike the deliberately unindexed scan behind publicStats, it earns a
      -- b-tree.
      -- The write cost is per completed run, not per request.
      CREATE INDEX IF NOT EXISTS idx_run_signals_recorded ON run_signals(recorded_at);
    `);
    // ...and the column the CREATE TABLE above cannot add to a database that
    // already has a sessions table.
    this.addCompletionColumn();
  }

  /**
   * Add `sessions.first_completed_at` to an already-deployed database, and
   * backfill it.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op once the table exists, so editing the
   * statement above adds the column to fresh databases only — an existing one
   * needs the ALTER, or every write that stamps the column fails with "no such
   * column" and every run ends `failed` at the moment it would have succeeded.
   *
   * The backfill is an approximation, deliberately and only here: sessions that
   * finished before this column existed have no record of WHEN they finished, so
   * `updated_at` stands in. That is exact for a session nothing has touched since
   * (the completion was its last write) and late for one that was closed or
   * re-run afterwards. It cannot be earlier than the real completion, which is
   * the property that matters — `publicStats` reports `since` from the minimum,
   * and the count itself is unaffected either way.
   *
   * `failed` is not backfilled even though a failed session may well have
   * completed once before a feedback re-run broke: nothing distinguishes it from
   * one that failed on its first run, and undercounting is the honest direction
   * for a public tally. Going forward the stamp survives the re-run, so this only
   * ever affects sessions that predate the column.
   *
   * One more session is missed, for the same reason and only at the upgrade
   * moment: one that had completed and was **mid-feedback-re-run** (`queued` or
   * `running`) when the new build booted. It is not in the backfill set, and
   * `failStaleSessions` then marks it `failed` on that same boot — so it is
   * excluded permanently rather than until its re-run finishes. Widening the
   * filter to include in-flight sessions would be worse: it would count first
   * runs that had never produced anything. Documented in docs/API.md §0b so the
   * one-off gap is explicable rather than mysterious.
   *
   * Unlike everything else in the constructor, `ALTER TABLE` is not idempotent,
   * so the check and the write are wrapped rather than trusted. Two processes
   * booting against one database in the same window both see no column, both
   * ALTER, and the loser would otherwise throw `duplicate column name` straight
   * out of `new Store()` — an uncaught boot crash, and not one `busy_timeout`
   * covers, since it is not a lock error. Re-checking on failure is what tells
   * "someone else already did this" (fine — the winner also runs the backfill)
   * from a real DDL error, which is rethrown. Multi-process is not a supported
   * topology, so this is defense in depth; it just costs three lines to put this
   * statement on the same footing as the IF NOT EXISTS block above it.
   */
  private addCompletionColumn(): void {
    const hasColumn = (): boolean =>
      (this.db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]).some(
        (c) => c.name === "first_completed_at",
      );
    if (hasColumn()) return;
    try {
      this.db.exec(`
        ALTER TABLE sessions ADD COLUMN first_completed_at TEXT;
        UPDATE sessions SET first_completed_at = updated_at
         WHERE status IN ('ready_for_review', 'closed');
      `);
    } catch (e) {
      if (!hasColumn()) throw e;
    }
  }

  /**
   * Build the `SET` clause shared by every session write, including the two
   * columns no caller passes: `updated_at`, and the write-once completion stamp.
   *
   * The stamp lives here rather than in the orchestrator so that "a session that
   * has reached ready_for_review is stamped" is a property of the store instead
   * of something each call site remembers. `COALESCE` is what makes it write
   * ONCE: the second and third times a session goes ready_for_review — every
   * feedback re-run does — the existing value wins, so the public tally counts
   * each set of page images once no matter how many times Iris re-read them.
   */
  private writeSet(patch: SessionPatch, now: string): { sets: string; values: unknown[] } {
    const keys = Object.keys(patch);
    const sets = keys.map((k) => `${k} = ?`);
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
    if (patch.status === "ready_for_review") {
      sets.push(`first_completed_at = COALESCE(first_completed_at, ?)`);
      values.push(now);
    }
    sets.push(`updated_at = ?`);
    values.push(now);
    return { sets: sets.join(", "), values };
  }

  /**
   * Refuse to open a database whose `users` table predates the removal of
   * `github_token` / `fork_repo`.
   *
   * There is deliberately **no migration**: every user starts from scratch, so a
   * pre-existing database is not a deployment to be upgraded — it is a leftover, and
   * the honest response is to say so rather than to quietly adopt it.
   *
   * A check is still needed, because `CREATE TABLE IF NOT EXISTS` in the constructor
   * is a no-op when the table already exists. Without this, a stray `data/` directory (a
   * development leftover, a restored backup, a volume mounted from an older image)
   * keeps the old table — `github_token TEXT NOT NULL` — while `upsertUser` no longer
   * supplies that column, and the two symptoms both point away from the cause:
   *
   *   * Every FIRST-TIME login throws `NOT NULL constraint failed:
   *     users.github_token` inside the auth middleware's try, which answers
   *     `401 unauthorized` with the SQLite message in the body. Anyone who already
   *     has a row keeps working, so it reads as "GitHub is flaky for new signups"
   *     rather than as a schema mismatch.
   *   * The plaintext tokens in that file stay there, now never refreshed and never
   *     cleared, while `getUser`'s `SELECT *` still returns them — so
   *     `req.user.github_token` exists at runtime although `UserRecord` says it
   *     cannot. The claim that a stolen copy of `data/iris.sqlite` is not GitHub
   *     access would be false for exactly that file.
   *
   * Failing at startup is what makes "starting from scratch" a checked precondition
   * instead of an assumption. It also keeps the fix in the operator's hands: deleting
   * the file is a decision about live credentials, and a silent rebuild-and-VACUUM
   * would be this service erasing data nobody asked it to touch.
   *
   * Which is why this runs FIRST, before the schema block and before `journal_mode`.
   * "We will not adopt this file" and "we already modified this file" cannot both be
   * true, and the modifications are the kind an operator would need undone: the DDL
   * drops the index the older build's `listSessions` pages on, so a rollback to that
   * build in order to export session history before deleting the file would meet a
   * schema its queries no longer match. `PRAGMA table_info` on a table that does not
   * exist returns no rows, so a fresh or current database falls straight through.
   */
  private rejectLegacyUsersTable(path: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    const legacy = cols.map((c) => c.name).filter((n) => n === "github_token" || n === "fork_repo");
    if (legacy.length === 0) return;
    this.db.close();
    throw new Error(
      `${path} was created by an older version of Iris: its users table still has ` +
        `${legacy.join(" and ")}. There is no migration — GitHub tokens are no longer stored at ` +
        `all, and every user re-authorizes from scratch. Delete the database (and its -wal/-shm ` +
        `files) and restart; users log in again with GitHub and lose nothing but their session ` +
        `history. Note that the old file still contains plaintext GitHub tokens for every user ` +
        `who logged in, so delete it rather than archiving it.`,
    );
  }

  // --- users ---

  // On first auth a user account is provisioned with the deployment's default
  // max_review_iterations (PRD §9.1). Existing users keep their stored default; the
  // login is the only field an existing row refreshes, since it is the only one that
  // can change upstream and the token is not stored at all (see UserRecord).
  upsertUser(
    u: { github_user_id: number; github_login: string },
    defaultMaxIter = 3,
  ): UserRecord {
    const existing = this.getUser(u.github_user_id);
    if (existing) {
      // Only the login can change (GitHub renames); the numeric id is stable and
      // is what everything else keys on.
      this.db
        .prepare(`UPDATE users SET github_login = ? WHERE github_user_id = ?`)
        .run(u.github_login, u.github_user_id);
      return this.getUser(u.github_user_id)!;
    }
    this.db
      .prepare(
        `INSERT INTO users (github_user_id, github_login, max_review_iterations, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(u.github_user_id, u.github_login, defaultMaxIter, new Date().toISOString());
    return this.getUser(u.github_user_id)!;
  }

  getUser(id: number): UserRecord | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE github_user_id = ?`).get(id) as UserRecord | undefined;
  }

  // --- sessions ---

  createSession(s: {
    session_id: string;
    github_user_id: number;
    image_count: number;
    iterations_max: number;
  }): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions
         (session_id, github_user_id, status, phase, iterations_completed, iterations_max, image_count, error, created_at, updated_at)
         VALUES (?, ?, 'queued', 'extraction', 0, ?, ?, NULL, ?, ?)`,
      )
      .run(s.session_id, s.github_user_id, s.iterations_max, s.image_count, now, now);
    return this.getSession(s.session_id)!;
  }

  // Sessions run in-process; after a restart any still-"running"/"queued" rows
  // are orphaned (the process that drove them is gone). Mark them failed so
  // clients stop polling a run that will never finish.
  //
  // SINGLE-INSTANCE ONLY, and this is the sharpest edge of that constraint: no
  // row records which process owns a run, so this cannot distinguish "orphaned"
  // from "a peer instance is running it right now". A second instance booting
  // against the same data_dir marks the first instance's live runs `failed` —
  // the pipeline keeps going and still writes output.html, but the client is
  // told the conversion failed. Declared in README's implementation notes;
  // making it safe needs an owning-instance id, not a change here.
  failStaleSessions(): number {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `UPDATE sessions SET status = 'failed', error = 'interrupted (server restarted)', updated_at = ?
         WHERE status IN ('running','queued')`,
      )
      .run(now);
    return Number(res.changes);
  }

  getSession(id: string): SessionRecord | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(id) as SessionRecord | undefined;
  }

  updateSession(id: string, patch: SessionPatch): void {
    if (Object.keys(patch).length === 0) return;
    const { sets, values } = this.writeSet(patch, new Date().toISOString());
    this.db.prepare(`UPDATE sessions SET ${sets} WHERE session_id = ?`).run(...(values as never[]), id);
  }

  // Apply `patch` only if the session is still in `expected`, and report whether
  // this call is the one that did it. The status test and the write are one
  // statement, so exactly one of two concurrent callers can win: SQLite reports 0
  // changed rows to the loser.
  //
  // This replaces read-status-then-write in the endpoints that start work on a
  // session (`POST /:id/feedback`, `POST /:id/close`). Those handlers are fully
  // synchronous, so within one process there is no await between the check and the
  // write and the plain pattern is already safe — the gap only opens across
  // processes, where two instances share this WAL database. Verified: two processes
  // racing the read-then-write pattern at a shared wall-clock instant both reported
  // "won"; through this method exactly one does.
  //
  // A second instance is not the supported topology (the queue is in-process and
  // `failStaleSessions` assumes it), so this is defense in depth rather than a fix
  // for a reachable bug today. It earns its place by being the *cheaper* invariant
  // to hold: correctness stops depending on every future handler staying
  // synchronous. Adding one `await` between the guard and the write in a handler —
  // the ordinary thing to do when a check needs I/O — would silently reintroduce
  // the race in-process, and a duplicated feedback run is invisible in the response
  // (both callers get a 202) while two pipelines write the same output.html and
  // fragments/final.json.
  claimSession(id: string, expected: SessionStatus, patch: SessionPatch): boolean {
    if (Object.keys(patch).length === 0) return false;
    const { sets, values } = this.writeSet(patch, new Date().toISOString());
    const res = this.db
      .prepare(`UPDATE sessions SET ${sets} WHERE session_id = ? AND status = ?`)
      .run(...(values as never[]), id, expected);
    return Number(res.changes) > 0;
  }

  // Keyset pagination over (created_at DESC, session_id DESC).
  //
  // This used to page on `created_at < ?` alone. `created_at` is a millisecond
  // ISO-8601 timestamp and sessions are created by an HTTP handler, so two rows
  // sharing one is not a corner case — it is what a burst of uploads looks like.
  // With a non-unique sort key the old query lost and duplicated rows at every
  // page boundary that fell inside a tie: `<` skipped every other row sharing the
  // last row's timestamp (they never appear on any page), while SQLite is free to
  // order the tied rows differently between the two queries, so a row already
  // returned could come back on the next page. Neither shows up in testing at
  // small volume, and both silently corrupt any client that walks pages to build
  // a list.
  //
  // The predicate is the row-value form `(created_at, session_id) < (?, ?)`
  // rather than the equivalent `created_at < ? OR (created_at = ? AND ...)`
  // expansion. Only the row-value form is visible to SQLite's planner as an
  // index bound: it seeks
  // (`SEARCH ... USING INDEX ... (u=? AND (created_at,session_id)<(?,?))`)
  // where the OR-expansion degrades to scanning every one of the user's rows
  // (`SEARCH ... (u=?)`). Not a COVERING index seek — this is `SELECT *`, so the
  // row has to be fetched from the table either way; the index earns its keep by
  // bounding which rows are visited, not by answering the query alone.
  listSessions(
    userId: number,
    opts: { status?: string; limit: number; cursor?: SessionCursor },
  ): SessionRecord[] {
    const params: unknown[] = [userId];
    let where = `github_user_id = ?`;
    if (opts.status) {
      where += ` AND status = ?`;
      params.push(opts.status);
    }
    if (opts.cursor) {
      // Strictly after the last row of the previous page, in the same total order
      // the ORDER BY below imposes — the two must match exactly or rows are
      // skipped.
      where += ` AND (created_at, session_id) < (?, ?)`;
      params.push(opts.cursor.created_at, opts.cursor.session_id);
    }
    // Clamped, not trusted. SQLite reads a NEGATIVE limit as *no* limit, so
    // `LIMIT -4` returns the user's entire session table — a caller that computed
    // its limit with `parseInt(x) || 20` (where a negative x is truthy and
    // survives) turns one list request into a full scan, and nothing about the
    // response says so. Refusing it here rather than only at the route means the
    // query cannot be made unbounded by arithmetic upstream of it.
    params.push(Math.max(1, Math.floor(opts.limit) || 1));
    return this.db
      .prepare(
        `SELECT * FROM sessions WHERE ${where} ORDER BY created_at DESC, session_id DESC LIMIT ?`,
      )
      .all(...(params as never[])) as unknown as SessionRecord[];
  }

  // --- public stats ---

  /**
   * The deployment-wide totals behind `GET /v1/stats`: how many page images Iris
   * has converted, across how many documents, and since when.
   *
   * Aggregate only, and that is a requirement rather than a simplification —
   * this feeds an UNAUTHENTICATED endpoint. Every value here is a count over the
   * whole table: no user id, no login, no session id, no filename, and no content.
   *
   * What that does NOT promise, since the endpoint is public and pollable: the
   * DELTA between two reads is a per-upload figure. `documents_processed` +1
   * alongside `pages_processed` +40 says a 40-page document finished in that
   * window, and on a quiet deployment the aggregate IS the individual. The route's
   * 60s cache coarsens when that shows up, not the page count. Nothing identifying
   * is inferable from it — no who, no what — so the query is right as it stands;
   * an operator who considers document sizes sensitive should not expose this
   * endpoint publicly, and this paragraph is here so that stays a decision rather
   * than a surprise.
   *
   * "Processed" means a session that reached ready_for_review at least once, so:
   *
   *   * A queued or in-flight run is not counted yet — the pages have been
   *     uploaded, not converted.
   *   * A run that has NEVER completed is not counted, since nothing was
   *     delivered. Note the asymmetry with a `failed` status: a session that
   *     completed once and then failed a feedback re-run stays counted, because
   *     its pages really were made accessible and the user still has that output.
   *   * A feedback re-run does not count its pages a second time. The tally is
   *     of distinct page images Iris has made accessible, not of model calls, so
   *     re-reading page 3 four times is still one page (see writeSet).
   *
   * There is no index for the `IS NOT NULL` filter: this is a full scan of a
   * table with one row per upload, behind a 60s response cache at the route, so
   * an extra b-tree to maintain on every session write would cost more than it
   * saves. If sessions ever grow to the point where this matters, a partial index
   * on (first_completed_at, image_count) covers this query exactly.
   */
  publicStats(): { pages: number; documents: number; since: string | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS documents,
                COALESCE(SUM(image_count), 0) AS pages,
                MIN(first_completed_at) AS since
           FROM sessions
          WHERE first_completed_at IS NOT NULL`,
      )
      .get() as { documents: number; pages: number; since: string | null };
    return { pages: Number(row.pages), documents: Number(row.documents), since: row.since ?? null };
  }

  /**
   * How well the output has been going, in the two numbers `GET /v1/stats` may say in
   * public — or `null` when the window holds too few documents to say anything at all
   * (see `PUBLIC_QUALITY_MIN_DOCUMENTS`, which is the interesting part of this method).
   *
   * Windowed at `DEFAULT_QUALITY_WINDOW_DAYS` and not caller-adjustable, unlike
   * `qualityStats`. `/v1/stats` takes no parameters — a fixed window is what keeps its
   * single shared cache entry correct for every caller, and a public `?days=` would
   * additionally let anyone narrow the window until the denominator is one document,
   * walking straight around the floor this method exists to enforce.
   *
   * `null` rather than zeros for the below-floor case. Zeros would be read as a
   * measurement — "0% clean" is the worst possible claim — and the route has no way to
   * tell a real zero from an absent one. The demo page's line is already written to
   * disappear rather than say something hollow.
   *
   * Reads the same `run_signals` rows as `qualityStats` and reports nothing that is not
   * derivable from them, so the two can only disagree by window. `clean_rate` is the one
   * field that is not a single one of those rates: it is the share of documents carrying
   * NEITHER `iris:unresolved` nor `iris:review-unread`, which cannot be recovered from the
   * two rates separately because a document may carry both. Two small aggregate queries
   * behind the route's 60s cache, on a table with at most one row per (session, code).
   */
  publicQuality(): PublicQuality | null {
    const cutoff = new Date(Date.now() - DEFAULT_QUALITY_WINDOW_DAYS * 86_400_000).toISOString();
    // `iris:rounds` is present for every delivered document, so COUNT(*) over it is
    // the document count and SUM(count) is the total editor passes across them.
    const base = this.db
      .prepare(
        `SELECT COUNT(*) AS documents, COALESCE(SUM(count), 0) AS rounds
           FROM run_signals
          WHERE code = ? AND recorded_at >= ?`,
      )
      .get(SIGNAL_ROUNDS, cutoff) as { documents: number; rounds: number };
    const documents = Number(base.documents);
    if (documents < PUBLIC_QUALITY_MIN_DOCUMENTS) return null;

    // Documents that are NOT clean, which is two different things and both of them have to
    // be here (#186). `iris:unresolved` is a document the reviewer left issues open on.
    // `iris:review-unread` is a document part of which the reviewer never answered about —
    // it has no unresolved row precisely BECAUSE nothing was found, so subtracting only the
    // first counted silence as a clean bill of health, on the one kind of document where
    // there is no verdict at all. Same principle as `documents_linted` in `qualityStats`:
    // an absent measurement must not be published as a good one.
    //
    // COUNT(DISTINCT session_id) rather than COUNT(*): (session_id, code) is the primary
    // key, so one document contributes at most one row PER CODE but can hold both, and
    // counting rows would subtract that document twice — which is what the clamp below
    // would then be hiding. A signal recorded only when non-zero is why this is a
    // subtraction rather than a `count = 0` filter.
    const notClean = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(DISTINCT session_id) AS documents
               FROM run_signals
              WHERE code IN (?, ?) AND recorded_at >= ?`,
          )
          .get(SIGNAL_UNRESOLVED, SIGNAL_REVIEW_UNREAD, cutoff) as { documents: number }
      ).documents,
    );

    return {
      window_days: DEFAULT_QUALITY_WINDOW_DAYS,
      documents,
      // Both divisions are safe: the floor above guarantees documents >= 20. The clamp
      // covers the one way the subtraction could go negative — a row whose `iris:rounds`
      // partner is missing, which the recorder never writes but a half-applied migration or
      // a hand-edited database could leave behind. A negative percentage on the front page
      // is a worse outcome than a slightly optimistic one.
      clean_rate: Math.min(1, Math.max(0, (documents - notClean) / documents)),
      mean_rounds: Number(base.rounds) / documents,
    };
  }

  // --- run quality signals (PRD §7.16) ---

  /**
   * Record what one delivered document cost us, replacing anything previously
   * recorded for that session.
   *
   * Called once per successful run, from the orchestrator, with the final axe
   * violations plus the `iris:` measurements. Nothing is recorded for a run that
   * failed: the point of the tally is the quality of what we DELIVERED, and a run
   * that produced no document has no output to judge.
   *
   * **Replace, not append**, and this is the whole reason the write is not a plain
   * insert. A feedback re-run is the same session converted again — every one of
   * them would otherwise add a second set of rows, so the documents people asked
   * Iris to retry (which correlate with the documents that came out badly) would
   * each be counted two, three, four times. That skews the rate in the worse
   * direction, on precisely the documents most likely to carry a signal, and it
   * would have made every number here read high for a reason that has nothing to
   * do with the prompts.
   *
   * The DELETE is what handles the other half: a rule that fired on the first run
   * and does NOT fire on the re-run has to disappear, and an upsert alone would
   * leave the stale row behind — so a problem the user's feedback actually fixed
   * would keep being reported as present. `INSERT OR REPLACE` covers only the rows
   * the new run supplies.
   *
   * Wrapped in a transaction so a crash between the two statements cannot leave the
   * session with no signals at all, which would silently drop it out of the
   * denominator and make every rate computed from it slightly wrong in a way nothing
   * could detect afterwards.
   */
  recordRunSignals(sessionId: string, signals: RunSignal[]): void {
    const now = new Date().toISOString();
    // De-duplicated in memory first. `code` is half the primary key, so two rows
    // sharing one inside a single call would abort the whole transaction — and axe
    // reporting one rule twice is not this method's business to police. Later wins;
    // the counts are summed, since two entries for one rule are two sets of nodes.
    const merged = new Map<string, RunSignal>();
    for (const s of signals) {
      if (!s.code) continue;
      const prior = merged.get(s.code);
      merged.set(s.code, {
        code: s.code,
        impact: s.impact ?? prior?.impact ?? null,
        count: (prior?.count ?? 0) + (Number.isFinite(s.count) ? Math.max(0, Math.floor(s.count)) : 0),
      });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`DELETE FROM run_signals WHERE session_id = ?`).run(sessionId);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO run_signals (session_id, code, impact, count, recorded_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const s of merged.values()) {
        insert.run(sessionId, s.code, s.impact ?? null, s.count, now);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * The deployment-wide quality tally behind `GET /v1/quality` (PRD §7.16).
   *
   * Windowed on purpose — see DEFAULT_QUALITY_WINDOW_DAYS. An all-time rate is the
   * shape to avoid: it converges, stops responding to a fix, and so cannot answer
   * the question the weekly workflow exists to ask ("is this still happening?").
   *
   * Rates are per DOCUMENT, not per occurrence, and the two are not
   * interchangeable. "heading-order fails on 38% of documents" names a prompt
   * defect and is directly actionable; "heading-order is 38% of our violations"
   * moves when an unrelated rule is fixed and can be dominated by one pathological
   * 400-page scan. The per-node total is reported alongside as `nodes` rather than
   * folded into the rate.
   *
   * Aggregate only, and for a stronger reason than publicStats': that endpoint is
   * public but harmless, whereas this one's values are copied into public GitHub
   * issues by the workflow that reads it. No session id, no user, no filename, no
   * document text — see QualityStats.
   */
  qualityStats(opts: { days?: number } = {}): QualityStats {
    const days = clampQualityWindow(opts.days);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    // The denominator, and the rounds figure, from the one signal every delivered
    // document has.
    const base = this.db
      .prepare(
        `SELECT COUNT(*) AS documents, COALESCE(SUM(count), 0) AS rounds, MIN(recorded_at) AS since
           FROM run_signals
          WHERE code = ? AND recorded_at >= ?`,
      )
      .get(SIGNAL_ROUNDS, cutoff) as { documents: number; rounds: number; since: string | null };
    const documents = Number(base.documents);

    // Our own measurements, keyed by code. COUNT(*) is a document count because of
    // the (session_id, code) primary key.
    const ours = new Map<string, number>();
    for (const row of this.db
      .prepare(
        `SELECT code, COUNT(*) AS documents
           FROM run_signals
          WHERE recorded_at >= ? AND code LIKE 'iris:%'
          GROUP BY code`,
      )
      .all(cutoff) as unknown as { code: string; documents: number }[]) {
      ours.set(row.code, Number(row.documents));
    }

    // Documents the linter actually examined. A document whose lint could not run
    // contributes no rule rows at all, so it belongs in neither half of a rule's ratio —
    // see QualityStats.rules.share. Floored at 0 rather than trusted: the two counts come
    // from separate queries over the same window, and a negative denominator would turn a
    // share into something a threshold comparison reads as fine.
    const documentsLinted = Math.max(0, documents - (ours.get(SIGNAL_LINT_ERROR) ?? 0));

    // Everything that is not ours is an axe rule id.
    const rules = (
      this.db
        .prepare(
          `SELECT code,
                  MAX(impact) AS impact,
                  COUNT(*) AS documents,
                  COALESCE(SUM(count), 0) AS nodes
             FROM run_signals
            WHERE recorded_at >= ? AND code NOT LIKE 'iris:%'
            GROUP BY code
            ORDER BY documents DESC, nodes DESC, code ASC`,
        )
        .all(cutoff) as unknown as { code: string; impact: string | null; documents: number; nodes: number }[]
    ).map((r) => ({
      id: r.code,
      impact: r.impact ?? null,
      documents: Number(r.documents),
      share: documentsLinted ? Number(r.documents) / documentsLinted : 0,
      nodes: Number(r.nodes),
    }));

    // Guarding the division rather than trusting it: an empty window is the normal
    // state of a fresh deployment, and 0/0 is NaN, which serializes to `null` in
    // JSON and would reach the workflow's threshold comparison as a silent false.
    const rate = (code: string): number => (documents ? (ours.get(code) ?? 0) / documents : 0);

    return {
      window_days: days,
      documents,
      since: base.since ?? null,
      mean_rounds: documents ? Number(base.rounds) / documents : null,
      unresolved_rate: rate(SIGNAL_UNRESOLVED),
      // Both of these are built from their closed vocabulary rather than from the rows, for
      // the reason given on `lint_error_where` below: a value that did not occur has to be a
      // recorded 0, or "none of these happened" and "this deployment does not record it" are
      // the same answer.
      unresolved_severity: UNRESOLVED_SEVERITY.map((severity) => ({
        severity,
        documents: ours.get(unresolvedSeveritySignal(severity)) ?? 0,
      })),
      review_stopped: REVIEW_STOPPED.map((where) => ({
        where,
        documents: ours.get(reviewStoppedSignal(where)) ?? 0,
      })),
      links_dropped_rate: rate(SIGNAL_LINKS_DROPPED),
      links_unresolved_rate: rate(SIGNAL_LINKS_UNRESOLVED),
      markup_unbalanced_rate: rate(SIGNAL_MARKUP_UNBALANCED),
      table_no_body_rate: rate(SIGNAL_TABLE_NO_BODY),
      structural_defect_rate: rate(SIGNAL_STRUCTURAL_DEFECT),
      lint_error_rate: rate(SIGNAL_LINT_ERROR),
      // Built from the closed vocabulary rather than from the rows, so a step that did not
      // occur is a recorded 0 and not a missing entry (see QualityStats.lint_error_where).
      lint_error_where: LINT_ERROR_WHERE.map((where) => ({
        where,
        documents: ours.get(lintErrorWhereSignal(where)) ?? 0,
      })),
      documents_linted: documentsLinted,
      editor_truncated_rate: rate(SIGNAL_EDITOR_TRUNCATED),
      editor_truncated_lost_rate: rate(SIGNAL_EDITOR_TRUNCATED_LOST),
      review_unread_rate: rate(SIGNAL_REVIEW_UNREAD),
      unfinished_page_rate: rate(SIGNAL_UNFINISHED_PAGE),
      rules,
    };
  }
}
