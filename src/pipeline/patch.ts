// The Copy Editor's reply as a patch against the document's top-level blocks, instead of the
// document retyped (issue #250).
//
// Why the contract changed. The editor was asked for the complete corrected body, so the LENGTH
// OF ITS ANSWER was a property of the document and not of how much was wrong with it. Measured
// across 34 delivered documents: a mean encoded reply of ~26,600 tokens, against a ceiling that
// was 32,000 for that corpus (`DEFAULT_MAX_TOKENS` unless a provider overrides it, and
// `copy_editor` has no override) — 15 of the 34 could not fit under it at all. That is the
// mechanical cause of the 58% `editor_truncated` rate, and a cause no choice of model can move,
// since a model cannot emit a reply longer than its ceiling. The same corpus puts the blocks a
// round actually touches at ~1,211 tokens: a twentieth of the answer, and the whole of the work.
//
// Why the anchor is a block POSITION and not an id. The first form of #250 asked for
// `{ id, html }` pairs, and the bench's own $0 check refuted it before a round was paid for: of the
// 13 defect instances markup.ts's own checks find across those 34 documents, NONE sits on an
// element with a usable id and none has an ancestor carrying one. Iris puts ids on the things that
// get linked TO — page-break markers, cross-reference anchors, footnote items — so content has
// none above it (`IMG < FIGURE < MAIN < BODY < HTML`). An id-anchored contract reaches none of
// those 13 — which is a small number, and the smallness is the point: these are what a script can
// PROVE, so the sentence is about the anchor failing on the work it can be checked against.
//
// Those are corrected figures (#268); this paragraph used to read "73 instances, 12 (16%) with a
// usable id … one defect in six". Two things were wrong with the old count and neither moves the
// decision. It called a `lang` on a void element a defect whatever else that element carried, so
// 54 of the 73 were `<img lang="en" alt="Meta logo">` and `<hr lang="en" aria-label="Page 33">` —
// correct authoring under the narrower rule markup.ts applies, and the population nearly every id
// in the table came from, since a page marker gets an id and a paragraph does not. And it counted
// two classes markup.ts deliberately does not: a fragment emitting its own `<main>`, which
// landmarks.ts fixes rather than counts, and a fragment-level dangling `href="#x"`, which assembly
// resolves across pages. So 13 and 73 are not the same population — but the correction runs the
// same way whichever is read, and further: an id-anchored contract that reached one defect in six
// was worth arguing about, and one that reaches none of them is not.
//
// The anchor that does reach the work is already in the codebase: `splitBlocks` (sections.ts)
// cuts the body at top-level boundaries, which is the same cut the editor's own truncation
// fallback already corrects at. So no new markup, no new locating code, and the pieces are small
// enough to return.
//
// The numbering is put IN FRONT OF the editor rather than counted by it — see `annotateBlocks`.
// A model that had to count blocks itself could be off by one and still land in range, which is
// the one failure here that no check downstream can see: every edit applied to the wrong block,
// each replacement well-formed. Copying a number that is written above the block cannot make that
// mistake.
import { structureCounts, visibleText } from "./correction.ts";
import { joinSections, splitBlocks, topLevelComplete, type Section } from "./sections.ts";

// The marker written above each block in the copy of the body the editor is shown. House style
// for a comment addressed to a reader of the markup rather than to a browser is `@name`
// (`@unresolved`, `@page-failed`, `@editor-truncated` in assembly.ts), and this one is never
// written into a delivered document — it exists only in the request.
const BLOCK_MARKER = /<!--\s*@block\s+\d+\s*-->/g;

// Take the markers back out of text a model returned, and say how many there were.
//
// Exported because BOTH shapes of reply need it, and only one of them is a patch. A model that
// answers with the whole document under this contract answers with the document it was SHOWN —
// markers and all — and adopting that verbatim writes Iris's own request scaffolding into the
// delivered HTML. It also compounds: a comment is a top-level node, so the next round's blocks
// are the markers as well as the content, and the body doubles every round while every round
// reads as `changed`. Nothing downstream removes these — the strip is the only place they go.
export function stripBlockMarkers(html: string): { html: string; markers: number } {
  const found = html.match(BLOCK_MARKER);
  return { html: found ? html.replace(BLOCK_MARKER, "") : html, markers: found?.length ?? 0 };
}

// Did this replacement hand back less of the document than the block it replaces?
//
// Read on the PROSE first, not the bytes: unwrapping a mis-structured block — `<div><p>x</p></div>`
// to `<p>x</p>` — is shorter markup carrying every word, and counting that as content leaving would
// report the commonest legitimate structural fix as a loss.
//
// But prose is not all a block holds, and the two things it holds that carry no words are the two
// this loop exists to protect: an `<img>` with its alt text, and an `<a>` with its href. A source
// block that hands back its figcaption and drops the image is byte for byte a shrink no prose
// comparison can see — the words are unchanged — and an image leaving the deliverable is a worse
// loss than a sentence. `structureCounts` reads them with a scanner that steps over quoted
// attribute values, so `<img alt="see <p> below">` is one image and not also a paragraph.
//
// Deliberately NOT every structure count: re-levelling headings, splitting one paragraph into two
// or turning a `<dl>` into a `<ul>` are the corrections this loop asks for, and each moves a count
// down without taking anything out of the document. Which three ARE read, and why those, is
// `NAVIGABLE` below.
const NAVIGABLE = ["headings", "items", "rows"] as const;

export type Navigable = (typeof NAVIGABLE)[number];

// The structures a reader NAVIGATES BY, whose loss is invisible to every other reading (#271).
//
// The third case, alongside prose and the two wordless things above. A heading rewritten as a
// paragraph of the same words, a list flattened into one, a table's rows run together: every word
// survives, no image or link is touched, the bytes may even grow — and what a screen-reader user
// lost is the only means they had of finding that content, because the heading list, the "list of
// N items" announcement and the row-by-row walk are all gone. `agents/page.md` already names this
// shape as a hazard on the re-extraction pass, in as many words — "a level that moved, a cell's
// list flattened, a <dl> turned back into paragraphs all arrive as this page's content, and the
// version that had them right is not kept anywhere" — and the measured evidence for it on the
// review path is #271: 13 of 151 bench rounds lost headings, 5 of them while losing no text at all.
//
// These three and not the other eight, and the other eight are excluded on the same one test that
// decides which of the three may be READ ON ITS OWN: can a correction this loop ASKS FOR move the
// count down while every word stays?
//
//   - `terms` and `definitions` are out on measurement rather than on principle. The whole-body
//     round in `runs-231` rewrote a 55-item `<dl>` into list items, moving `terms` 55 -> 3 while its
//     prose moved 0.3% and every word survived — the round `EDITOR_SHRINK_FLOOR` is placed off.
//   - `cells` is out because correcting a table's headers is `<td>` -> `<th>`, which takes it down by
//     exactly the number corrected, and that correction is in EDITOR_SYSTEM by name.
//   - `paragraphs`, `lists`, `tables` and `captions` are container counts: two of anything the
//     extractor split across a page turn, merged back into one, is a fall on a round that did its job.
//
// `headings` passes that test and is therefore the one that counts as content given up. It is folded
// across h1-h6 by `structureCounts`, so "fix heading hierarchy" — the re-levelling EDITOR_SYSTEM
// sanctions by name, and the case the comment above excludes the structure counts for — does not
// move it at all. What takes it down is a heading that stops being a heading. The one removal the
// prompt does sanction — dropping a title the pages reprinted — takes that title's words with it, so
// it is already a prose shortfall and never reaches this reading at all.
//
// Where a demoted heading IS the same content announced another way, and the limit of the claim
// above: EDITOR_SYSTEM also sanctions "correct labels and table headers", and a `<form>` is one
// block, so a field label the extractor emitted as `<h4>Name</h4>` corrected to
// `<label for="name">Name</label>` keeps every word and takes `headings` down by one. Same for a
// heading corrected into a `<caption>`, a `<dt>` or a `<th>` where both sit inside one wrapper block.
// Not compensated for, deliberately: `structureCounts` does not count `<label>`, `<legend>`,
// `<figcaption>` or `<summary>` at all, so a rule that discounted a `headings` fall wherever
// `captions`/`terms`/`header_cells` rose would cover three of those cases and miss every one of the
// four uncounted destinations, including the one that is likeliest — and it would be machinery for
// a shape no round on file has produced. So the cost is accepted rather than compensated for, and
// since #331 it is paid with no refusal needed beside it — which is why what it costs had to come
// down. It is now ONE BLOCK, not the round: the caller hands that block back untouched and applies
// everything else in the reply (`headings_dropped` below, read by `applyEditorPatch`). The first
// version of #331 discarded the whole reply, which on this exact input — a `<label>` correction axe's
// `wcag2a` `label` rule asks for by name — threw away every other correction in it, on every round,
// until `max_review_iterations` ran out. That is the failure mode the header comment on
// `applyBlockEdits` exists to rule out, and a gate is not exempt from it. What the measurement below
// says, if this happens at all, is how often.
//
// The SAME correction split across two blocks is a different case and is not narrowed: the extractor
// commonly emits that label as a stray `<h4>` sibling of the form rather than inside it, and the fix is
// then two edits — empty the sibling, seat the `<label>` in the form. Nothing binds the two, so
// handing the emptied block back would print its words twice. `content_dropped` below is what keeps
// that block out of the salvage, and a reply with nothing left to seat is refused whole.
//
// `items` and `rows` do NOT pass it, and they are reported rather than read (#271 asked for all
// three; this is the half of it the evidence does not support). Both are ambiguous in a way
// `headings` is not, because the content can land in a DIFFERENT announced structure with every word
// intact: a `<ul>` rewritten as the `<dl>` agents/page.md asks for takes `items` to 0, and a list
// mis-extracted as a single-column table, corrected, takes `rows` to 0. Read as a loss, each would
// report a working round as damage. Read as a measurement they are worth having — a list flattened
// into paragraphs and a table's rows run together are real and are invisible everywhere else — and
// what would settle whether either can gate is the rate at which a working round moves them, which
// no round on file measures. `navigationLost` below is where that rate now comes from. A grouped
// total was tried on paper first and does not rescue them: summing the list-ish counts makes
// `<ul>` -> `<dl>` rise, but it makes the measured `runs-231` round fall.
//
// What is NOT claimed, even for headings: that a fall is damage. It is a fall the other readings
// cannot see, which is a different thing — removing content the document printed twice is this
// loop's job and reaches `shrunk` as a fall too. `shrunk` has never meant "wrong" (see
// `PatchReport`), and the gate it feeds is scoped to the block that fell rather than to the reply,
// precisely because a fall is not a verdict on the round it arrived in.
function gaveContentUp(before: string, after: string): boolean {
  if (droppedContent(before, after)) return true;
  return structureCounts(after).headings < structureCounts(before).headings;
}

// The words-and-media half of `gaveContentUp`, without its structure clause, because a caller deciding
// whether a block may be RE-SEATED needs exactly this half and `gaveContentUp` cannot give it: a block
// that dropped a heading satisfies `gaveContentUp` by construction, so every candidate for re-seating
// is already in `lost` and `lost` cannot separate them. What makes re-seating unsafe is the block's
// CONTENT having gone somewhere — the words another edit put back as a `<label>`, the image another
// block took — and this is the reading that says so. See `content_dropped` on `PatchReport`.
function droppedContent(before: string, after: string): boolean {
  if (visibleText(after).length < visibleText(before).length) return true;
  const [was, now] = [structureCounts(before), structureCounts(after)];
  return now.images < was.images || now.links < was.links;
}

// The navigation the DOCUMENT lost, read on the body the blocks assemble into rather than block by
// block, and reported per kind (#271).
//
// The grain is the whole point, and it is not the grain `shrunk` is read at. `shrunk` asks "did THIS
// block give content up", because its job is to spot the source half of a move — a heading carried
// from one block to another leaves the first one poorer, and that is exactly what it should say, so
// that a refusal on the landing half cannot take the heading with it. Summing those per-block falls
// would be a different number wearing this one's name: EDITOR_SYSTEM sanctions "reorder blocks", so a
// heading moved down past a paragraph is one block losing it and another gaining it, and a sum of
// falls would report a document that kept every heading as having lost one. Read on the joined body,
// a pure reorder is silent — which it has to be, because this number's whole use is to be the CLEAN
// population that says whether `items` and `rows` could ever gate.
//
// Only where the document's prose did not shorten, for the same reason the per-block rule reads prose
// first: a structure falling alongside a word loss is the ordinary shape of every deletion the prompt
// sanctions — a reprinted title dropped takes its own words — and those rounds are already `shrunk`.
// Counting them here as well would put the sanctioned case and the silent one in one number and leave
// neither readable.
//
// What the prose condition costs at THIS grain, since it is coarser here than it was per block: one
// sanctioned deletion anywhere in the reply silences the count for the whole round. A round that drops
// a reprinted title in one block and demotes a real heading in another logs nothing, and that round is
// a common one. Accepted rather than narrowed, because at document grain the alternative is not
// better — two headings are gone, one of them legitimately, and nothing in the counts says which — so
// reporting the pair would put a sanctioned deletion into the population as silent damage. This number
// is a sample used to decide whether `items` and `rows` can gate, and for that a filter that
// under-collects is right where one that over-collects is not: a missed round costs a row, and a
// wrong row costs the decision. What that silence now costs the DELIVERABLE, since #331 made this
// reading gate and not only report: that round ships with its real heading demoted, because the
// document-wide gate never sees it. Per-block `shrunk` does see it, but `shrunk` on its own has never
// refused anything — it turns into a refused round only where the same reply also holds a refusal
// (`refusal_with_loss` in `applyEditorPatch`). So the round that is sanctioned and silent in one reply
// is the shape this contract still cannot tell apart, and it is the reason the count under-collects
// rather than over-collects. `headings_dropped` below is read per block and is not subject to this
// condition, which is what keeps the two readings from having to be the same one.
//
// Reported as HOW MANY of each went, not as which kinds fell: one heading gone is a repeated title
// resolved a little too thoroughly and 84 is a document flattened, the two want different answers, and
// a name alone cannot tell them apart. It is also the quantity the bench harness records for the 151
// rounds behind #271 (`fidelity.headings_lost` in equalify-iris-bench's `editorround.mjs`, run
// `runs-editor-1` — outside this repo, so nothing here can assert on it), which lets the two be read
// against each other.
function navigationLost(before: string, after: string): Partial<Record<Navigable, number>> {
  const lost: Partial<Record<Navigable, number>> = {};
  if (visibleText(after).length < visibleText(before).length) return lost;
  const [was, now] = [structureCounts(before), structureCounts(after)];
  for (const k of NAVIGABLE) if (now[k] < was[k]) lost[k] = was[k] - now[k];
  return lost;
}

export interface BlockEdit {
  block: number;
  html: string;
}

export interface PatchReport {
  body: string;
  // Blocks whose text this replaced with something different.
  applied: number;
  // Blocks the editor emptied, which is how duplicated content is removed under this contract.
  deleted: number;
  // Edits that returned a block byte-identical to the one sent. Not an error and not a
  // correction: the editor spent output saying nothing, which is the cost this contract exists
  // to avoid, so it is counted rather than folded into `applied`.
  unchanged: number;
  // Block numbers the document does not have. Kept as numbers, not a count, because which ones
  // they are is the difference between a model that invented an anchor and one that answered
  // about a different document than the one it was sent.
  unknown: number[];
  // Edits naming a block an earlier edit already named. The first is kept: a reply that
  // contradicts itself about one block is not resolved by which contradiction came last, and
  // whichever is taken has to be deterministic.
  duplicate: number;
  // Replacements that were not a whole number of top-level nodes — a reply ending inside an
  // element. Those blocks keep their original text, because splicing in a fragment would close
  // its open tags with whatever followed it in the document.
  incomplete: number;
  // Marker comments taken back out of replacements. A model that copies the `<!-- @block 7 -->`
  // it was shown into what it returns is following the contract loosely rather than breaking it,
  // and the strip is exact — but the count is the evidence for how well the contract reads, so
  // it goes on the record.
  markers: number;
  // Applied replacements carrying LESS CONTENT than the block they replace. Not an error on its
  // own — removing a heading the document printed twice is this loop's job, and it shortens a
  // block — but it is the other half a move can have. The contract offers two ways to say what
  // becomes of the block content was taken out of: emptied (`deleted`), or returned "with what is
  // left of it", which is this. The caller needs both to tell whether a reply with a refusal in it
  // may be applied in part. See `gaveContentUp` for what counts as less.
  shrunk: number;
  // WHICH blocks those were: every block this emptied or handed back with less in it than it had,
  // i.e. the union of `deleted` and `shrunk` as block numbers. Not a third count and not a
  // breakdown — the two counts above are still the reading for a whole round — but the position
  // a caller applying only PART of a reply has to have (#317).
  //
  // Kept as numbers for the same reason `unknown` is: the one caller that reads it needs the
  // EARLIEST of them, because a reply cut partway through its list may be applied up to the first
  // block that gave content up and no further (`salvageRound`, pipeline/review.ts). A count cannot
  // answer "up to where", and deriving it from `deleted + shrunk` is not possible at all.
  //
  // In the order the edits were read, which is not necessarily block order — a reply whose list
  // closed may name its blocks in any order — so a caller wanting the first block takes the
  // minimum rather than the head.
  lost: number[];
  // Blocks that came back with FEWER HEADING ELEMENTS than they were sent, whatever else they did
  // (#331, narrowed by the review of #336). A subset of `lost` — a heading falling is one of the
  // things `gaveContentUp` reads — but not the same question, and the difference is the whole point
  // of having it: `lost` answers "up to where may a cut reply be applied", and this answers "which
  // blocks may not be applied at all". Because it is a subset, `lost` cannot be used to sort these
  // into safe and unsafe: that is what `content_dropped` is for.
  //
  // Why per block, when `navigation_lost` is deliberately read on the joined body: the two are
  // answering different halves of one question and neither can answer the other's. The joined reading
  // says whether the DOCUMENT lost a heading, which is the only grain at which a sanctioned reorder is
  // silent — so it is the right predicate for deciding that something must be refused. This says WHICH
  // blocks to refuse, which the joined reading cannot say at all, and without it the only available
  // answer was "the whole reply". That answer cost every other correction in it.
  //
  // Empty on the ordinary round, and empty whenever `navigation_lost.headings` is absent — but not the
  // converse: a reply whose prose shortened silences `navigation_lost` and still fills this in, and a
  // pure reorder fills this in with the source block while the document lost nothing. Both are why the
  // caller reads this only after the joined reading has said there is something to refuse.
  headings_dropped: number[];
  // Blocks whose own WORDS OR MEDIA went — prose shorter, or an `<img>` or `<a>` fewer — ignoring
  // structure entirely (`droppedContent`). The other half of the licence to re-seat a block, and the
  // half `headings_gained` is blind to.
  //
  // The hazard it exists for: a heading's words can migrate into another block as something
  // `structureCounts` does not count at all. The extractor emits a field label as a stray `<h4>`
  // SIBLING of the form, and the fix axe's `label` rule asks for is two edits — empty the stray block,
  // seat `<label for="name">Name</label>` inside the form. The document keeps every word, so the joined
  // prose is unmoved and `navigation_lost` reports the fall as ordinary; no heading arrived anywhere, so
  // `headings_gained` is 0. Re-seating the emptied block would print "Name" twice and leave an `<h4>`
  // heading nothing. `content_dropped` holds that block and the caller never re-seats it.
  //
  // Not `lost`, which is a superset: every block in `headings_dropped` is in `lost` already, because a
  // heading falling is one of the things `gaveContentUp` reads. `lost` also cannot be narrowed to this,
  // because `salvageRound` reads it to find where a cut reply must stop and #271's whole point is that a
  // demotion is a loss worth stopping at.
  //
  // An emptied block is in this only if it HELD something: `<h2></h2>` -> `""` has no words to move, so
  // the empty-heading false positive stays the cheap one — that block is re-seated and costs one block
  // for one round rather than the whole reply.
  content_dropped: number[];
  // Heading elements that ARRIVED in some block, summed across the reply. The number that says whether
  // `headings_dropped` can be acted on: a heading that left one block and turned up in another is a
  // reorder EDITOR_SYSTEM sanctions by name, and nothing here binds the two halves together, so a
  // caller reverting the source block on that reply would restore a heading the landing block already
  // has — one heading printed twice, invented by the guard.
  //
  // 0 is therefore half the licence — `content_dropped` is the other half — and it is exactly the
  // condition the outline guarantee rests on: no block took
  // a heading, so a document-wide fall means the heading is gone rather than moved, so handing back
  // every block that dropped one restores the outline exactly. Non-zero and the caller cannot tell
  // which source belongs to which arrival, and refuses the round whole rather than guess (see
  // `applyEditorPatch`). Counted rather than flagged because the quantity is the reader's next
  // question — one arrival beside one fall is a move, and eleven beside one is a restructure.
  headings_gained: number;
  // Navigable structure the DOCUMENT lost while every word stayed, per kind (#271) — the shape of
  // loss this pipeline had no signal for at all. Empty on the ordinary round.
  //
  // Not a breakdown of `shrunk`, and not read at the same grain: `shrunk` is per block because its
  // job is to spot the source half of a move, while this is read on the joined body so that a
  // sanctioned reorder is silent. See `navigationLost`. A `headings` fall the round did not undo
  // elsewhere will also be `shrunk`; `items` and `rows` are reported without counting as content
  // given up at all, so a line carrying `navigation_lost` with no `shrunk` beside it is a round that
  // re-expressed a list or a table — the population that would decide whether either can ever gate,
  // on the record before it is believed.
  //
  // Since #331 the `headings` member of this is the one that is READ and not only reported: a fall in it
  // is what tells the caller a heading has left the document rather than moved within it, which is the
  // question `headings_dropped` cannot answer and this one can. What the caller does about it is scoped
  // by that field rather than by this one — this says a heading is gone, that says where from.
  navigation_lost: Partial<Record<Navigable, number>>;
}

// The body as the editor is shown it: every top-level block preceded by its number.
//
// The whitespace `splitBlocks` keeps in each block's `pre` is left out. It is Iris's own — the
// gaps assembly put between pages — the editor is not asked to return it, and `joinSections`
// puts it back around whatever comes in. What the editor sees between two blocks is therefore
// the marker line, which is also the separation a reader needs.
export function annotateBlocks(blocks: Section[]): string {
  return blocks.map((b, i) => `<!-- @block ${i} -->\n${b.html}`).join("\n");
}

// Apply the editor's edits to the blocks they name, and report what became of each one.
//
// Every block not named comes back byte for byte (`joinSections`), which is the whole point of
// the contract: an untouched block costs no output tokens and cannot be damaged by a reply about
// something else. That is also why nothing here rejects the WHOLE reply when one edit is
// unusable — under the old contract a bad reply cost the document's corrections, and under this
// one it costs the block it was about.
export function applyBlockEdits(blocks: Section[], edits: BlockEdit[]): PatchReport {
  const replacements: (string | null)[] = blocks.map(() => null);
  const report: Omit<PatchReport, "body"> = {
    applied: 0,
    deleted: 0,
    unchanged: 0,
    unknown: [],
    duplicate: 0,
    incomplete: 0,
    markers: 0,
    shrunk: 0,
    lost: [],
    headings_dropped: [],
    content_dropped: [],
    headings_gained: 0,
    navigation_lost: {},
  };
  // Both directions of every replaced block's heading count, taken here rather than derived later
  // because the original block text is only in hand while the edit is being applied. Counted with
  // `structureCounts` for the same reason `gaveContentUp` does — folded across h1-h6, so re-levelling
  // moves neither side — and on every replacement including a deletion, which takes its whole count
  // down to nothing.
  const headings = (html: string) => structureCounts(html).headings;
  for (const edit of edits) {
    const at = edit.block;
    if (!Number.isInteger(at) || at < 0 || at >= blocks.length) {
      report.unknown.push(at);
      continue;
    }
    if (replacements[at] !== null) {
      report.duplicate++;
      continue;
    }
    // Stripped before the completeness check, not after: a marker is not markup the check should
    // be reading, and a reply that is complete apart from an echoed comment is a reply this can
    // use. Whitespace left over from a stripped marker is not content either, so a reply that was
    // nothing but markers is the deletion it looks like.
    const { html: stripped, markers } = stripBlockMarkers(edit.html);
    report.markers += markers;
    const html = stripped.trim() === "" ? "" : stripped;
    if (!topLevelComplete(html)) {
      report.incomplete++;
      continue;
    }
    if (html === "") {
      replacements[at] = "";
      report.deleted++;
      report.lost.push(at);
      if (headings(blocks[at]!.html) > 0) report.headings_dropped.push(at);
      if (droppedContent(blocks[at]!.html, "")) report.content_dropped.push(at);
      continue;
    }
    if (html.trim() === blocks[at]!.html.trim()) {
      // Compared trimmed, and stored as sent. A replacement that differs from its block only in
      // the whitespace around it has changed nothing about the document, and counting it as a
      // correction would report work that was not done.
      //
      // Recorded as an edit that did nothing rather than left as `null`: both deliver the same
      // markup, and the difference — the editor thought this block needed returning — is the
      // thing worth counting.
      replacements[at] = html;
      report.unchanged++;
      continue;
    }
    replacements[at] = html;
    report.applied++;
    const delta = headings(html) - headings(blocks[at]!.html);
    if (delta < 0) report.headings_dropped.push(at);
    if (delta > 0) report.headings_gained += delta;
    if (droppedContent(blocks[at]!.html, html)) report.content_dropped.push(at);
    if (gaveContentUp(blocks[at]!.html, html)) {
      report.shrunk++;
      report.lost.push(at);
    }
  }
  const body = joinSections(blocks, replacements);
  // Both sides through `joinSections`, so the two are assembled the same way and the reading cannot
  // pick up a difference the join itself made. `null` for every block is the body that went in.
  return { ...report, body, navigation_lost: navigationLost(joinSections(blocks, blocks.map(() => null)), body) };
}

// The editor's reply, read as edits. Exported for the caller's parse step and for the tests,
// which reach the shapes a model actually sends: a `block` that arrived as a string, an `html`
// that is missing, an entry that is not an object at all.
//
// Anything that is not a usable pair is dropped here rather than passed on as a half-edit —
// except a `block` this can read as a number, which is kept so `applyBlockEdits` can report it
// as unknown if the document has no such block. The distinction matters: an unreadable entry is
// a reply this code could not parse, and an out-of-range block is a reply that named a block
// this document does not have.
export function readBlockEdits(value: unknown): { edits: BlockEdit[]; unreadable: number } {
  if (!Array.isArray(value)) return { edits: [], unreadable: 0 };
  const edits: BlockEdit[] = [];
  let unreadable = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      unreadable++;
      continue;
    }
    const raw = entry as { block?: unknown; html?: unknown };
    // A number written as a string is the commonest shape a model sends for an integer field, and
    // reading it costs one line. Anything else — null, a list, "seven" — is not a block number.
    const block = typeof raw.block === "number" ? raw.block : typeof raw.block === "string" && /^\d+$/.test(raw.block.trim()) ? Number(raw.block.trim()) : null;
    // `html` absent is not the same as `html: ""`: the empty string is how this contract says
    // "delete this block", so it has to survive the check that drops a missing field.
    if (block === null || typeof raw.html !== "string") {
      unreadable++;
      continue;
    }
    edits.push({ block, html: raw.html });
  }
  return { edits, unreadable };
}

// The blocks of a body, for the caller that needs both the numbering and the annotated text.
export function blocksOf(body: string): Section[] {
  return splitBlocks(body);
}
