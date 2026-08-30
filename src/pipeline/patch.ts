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
// down without taking anything out of the document.
function gaveContentUp(before: string, after: string): boolean {
  if (visibleText(after).length < visibleText(before).length) return true;
  const [was, now] = [structureCounts(before), structureCounts(after)];
  return now.images < was.images || now.links < was.links;
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
  };
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
    if (gaveContentUp(blocks[at]!.html, html)) report.shrunk++;
  }
  return { ...report, body: joinSections(blocks, replacements) };
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
