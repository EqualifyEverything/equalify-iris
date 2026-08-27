import { decodeEntities } from "../util/html.ts";

// What a self-correction pass actually DID to a page.
//
// The pipeline verifies every page against its source image and re-renders the ones
// that fail (extraction.ts `extractPage`). On three real 25-page runs the Feedback
// Agent rejected 58 of 75 pages, so "verify, then correct if needed" is in practice
// always-correct: one document paid for 50 page calls to extract 25 pages, and
// verification alone was 24% of that document's bill (issue #137).
//
// Whether that is honest verification or a verifier calibrated to always find
// something is not a question the verdict can answer about itself — a page whose alt
// text was refined from "orange kayak" to "orange-yellow kayak" and a page that lost
// three table rows are the same `page_verify_failed` line today. So this measures the
// correction's EFFECT on the delivered HTML instead of asking the model to grade its
// own findings: a run whose corrections only ever move alt text is buying something
// very different from one whose corrections bring content back, and the difference is
// visible in the two fragments without a single extra model call.
//
// A scan rather than a parse, for the reason links.ts gives: this runs on model output
// mid-pipeline, where the fragment need not be well-formed yet, and a parser that
// repairs one side of a comparison differently from the other would report a change
// that is an artifact of the repair.

// Every tag name in document order, opening and closing, lowercased. Attributes are
// deliberately excluded — an `alt` rewrite is not a structural change, and it is the
// distinction this whole module exists to draw.
function tagShape(html: string): string {
  const tags: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9]*)/gi)) {
    tags.push(`${m[1]}${m[2].toLowerCase()}`);
  }
  return tags.join(",");
}

// The words a reader would read, with the markup taken out: comments dropped, tags
// dropped, entities decoded so `&amp;` and `&` are one text, whitespace collapsed so a
// re-indented fragment is not a changed one. Attribute values do not survive, which is
// what keeps this independent of `altText` below.
//
// The tag pattern steps over quoted attribute values rather than stopping at the first
// `>`, because model output does not always escape one: `<img alt="revenue > 2019">` cut
// at the first `>` leaves ` 2019">` behind as "visible text", and then rewriting only
// that alt reports `text_changed` and leaves `alt_only` — the one bucket this module
// exists to isolate. So: `<`, a tag-ish first character, then runs of unquoted
// characters and whole quoted strings, to the `>` that actually closes it (or the end of
// a fragment that was cut off mid-tag).
const TAG = /<[a-z!/?][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>?/gi;

// A comment, ending at `-->` or at the end of the fragment if the model never wrote one —
// which is how a parser reads an unclosed comment, and it has to be how both signals below
// read it or they disagree about the same characters: `TAG` swallows `<!-- note <p>` as one
// tag, so `visibleText` drops those words while `attrText` would harvest them as attribute
// names. Shared for that reason rather than repeated.
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

// Exported for the review loop's round sizes, which need the same reading of "how much prose is
// here" as `text_chars_before`/`text_chars_after` do — a round measured one way and a page
// correction measured another could not be read against each other, and #174 asks for exactly that
// comparison.
export function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(COMMENT, " ")
      .replace(TAG, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Elements that are a page's content although they hold no text of their own: a reader given one
// receives something, and `visibleText` above returns nothing for all of them. Kept as a named list
// because the question "does this fragment give a reader anything" has to be answerable without
// reference to what the page was supposed to contain — `<img>` and `<svg>` are the picture, `<math>`
// is the equation, `<table>` is a grid whose cells could all be empty and still be a table on the
// page, and a form control is something to operate.
//
// Void and near-void elements that are NOT here are the ones a reader receives nothing from: a
// wrapper (`<div>`, `<section>`, `<p>`) with nothing in it, a `<br>`, and a page-break `<hr>`, which
// says where a page began rather than what was on it.
const CONTENT_WITHOUT_TEXT =
  /<(?:img|svg|math|video|audio|object|embed|iframe|canvas|input|select|textarea|button|table)\b/i;

// Does this fragment give a reader anything at all?
//
// Beside `visibleText` because it is the same reading of the same characters, which is what makes it
// usable as a gate: comments are stripped first for the reason that function gives (`<!-- the <img>
// is overleaf -->` is prose about markup, not a picture), so a fragment made only of a comment, only
// of empty wrappers, or only of a page-break marker carries nothing.
//
// The page agent's blank-page declaration is the caller (extraction.ts `blankDeclaration`), and the
// distinction is not "is this string empty": across 818 initial renders in the bench logs, 78 replies
// delivered a fragment with nothing in it for a reader and 33 of those spelled it in markup — a
// comment, an empty `<p>`, a bare page-break marker — rather than as the empty `html` the prompt asks
// for (issue #219).
export function carriesContent(html: string): boolean {
  if (visibleText(html).trim() !== "") return true;
  return CONTENT_WITHOUT_TEXT.test(html.replace(COMMENT, " "));
}

// How many of each kind of structure a fragment holds. Exported for the review loop, on the
// same argument as `visibleText`: a round and a page correction measured by different scans
// could not be read against each other, and #174 asks for exactly that comparison.
//
// This is the signal #174's own measurement pointed at and neither path carries. Across the
// three review rounds whose input survived, LENGTH moved 1.6% while the structure counts moved
// 0.714–1.333 — one round dropping 5 of 7 lists and 13 of 47 list items, another gaining a
// table — so "how much of the document is left" and "how much of its structure is left" are
// different questions about the same round, and only the first has numbers on the line today.
// Which of them a floor should be read off is the open half of #174, and it cannot be settled
// without both being logged.
export interface StructureCounts {
  headings: number;
  paragraphs: number;
  lists: number;
  items: number;
  terms: number;
  definitions: number;
  tables: number;
  captions: number;
  rows: number;
  header_cells: number;
  cells: number;
  images: number;
  links: number;
}

// Grouped rather than one count per element name, and h1-h6 into one number in particular.
// Half of agents/page.md is about which LEVEL a heading takes — a sub-topic the page names is
// promoted, a group label above a cluster of them is their parent, a step of a procedure sits
// one level under it — so a round that re-levels a section is doing the job, and a per-level
// count would report every one of those as two structures changed. What no rule in that file
// asks for is a heading that stops existing, which is what this number sees.
//
// The residual that grouping leaves is NOT covered elsewhere, and this comment said it was for one
// push: a round that rewrote every heading in the body to the same level leaves a sequence with no
// downward skip, so the re-lint's `heading-order` is silent — it fires only where a level goes down
// by more than one (lint.ts documents that reach and pins it) — while `headings` here is unchanged
// and the prose pair is equal. Every level distinction in the outline would be gone with no number
// on the line to say so. The grouping is still the right call for the reason above; what it does
// not have is a second opinion behind it.
//
// The table counts are apart for the same missing-second-opinion reason, in the direction that
// costs nothing: no axe rule fires on a `<th>` demoted to a `<td>`, which is the loss that strips a
// table's header association from a screen reader, so header cells are counted APART from data
// cells rather than folded in with them, and `<caption>` too, since a dropped table name would
// otherwise be invisible here as well. The total is still available by addition; what is not
// recoverable from a total is which of the two a round turned into the other.
//
// `<a>` is counted although `droppedHrefs` already watches URLs: that check answers "did this
// href survive", and a round that turns three links into one keeping every URL in it is a
// different fact. Same for `<img>`, whose alt text has its own signal in this module and whose
// disappearance has none.
const STRUCTURE_GROUP: Record<string, keyof StructureCounts> = {
  h1: "headings", h2: "headings", h3: "headings", h4: "headings", h5: "headings", h6: "headings",
  p: "paragraphs",
  ul: "lists", ol: "lists", dl: "lists",
  li: "items",
  dt: "terms", dd: "definitions",
  table: "tables", caption: "captions", tr: "rows", th: "header_cells", td: "cells",
  img: "images", a: "links",
};

// Opening tags only. A closing tag is not a second structure, and model output mid-pipeline is
// not guaranteed to have one for every element it opens — counting both would make a fragment's
// numbers depend on how well-formed the reply happens to be, which is the artifact the scan
// exists to avoid. Comments are stripped first, for the reason `attrText` gives: `<!-- the <ul>
// continues overleaf -->` is prose about markup, not markup.
//
// Walked with `TAG`, which steps over whole quoted attribute values, rather than by scanning for
// `<` and a name: `<img alt="Figure 3 <p> label">` holds a `<p>` inside an attribute, and a scan
// that stopped at the angle bracket would count a paragraph there — then report one LOST when a
// round rewrote that alt text, which is a structure change invented by the reading. `visibleText`
// on the same `editor` line walks the same pattern for the same reason, and the two numbers have
// to be able to disagree about a round without disagreeing about what a character is.
export function structureCounts(html: string): StructureCounts {
  const out: StructureCounts = {
    headings: 0, paragraphs: 0, lists: 0, items: 0, terms: 0, definitions: 0,
    tables: 0, captions: 0, rows: 0, header_cells: 0, cells: 0, images: 0, links: 0,
  };
  for (const tag of html.replace(COMMENT, " ").match(TAG) ?? []) {
    const name = /^<([a-z][a-z0-9]*)/i.exec(tag);
    if (!name) continue;
    const group = STRUCTURE_GROUP[name[1].toLowerCase()];
    if (group) out[group]++;
  }
  return out;
}

// Every alt attribute's value, in document order, joined on a separator an attribute
// value cannot itself contain. A space would let a rewrite that moves one word from one
// image's description into the next one's compare equal to the original: both descriptions
// changed, and only the boundary between them says so.
//
// `\b` would open on the `alt` in `data-alt=` and in any other attribute ending in those
// three letters, so the name has to start on something that is not part of a longer one.
// What remains is prose that writes `alt="…"` as text about markup; both sides are scanned
// the same way, so such a fragment is compared consistently and a rewrite of it is reported
// as an alt change, which is the wrong bucket but not a wrong answer about whether the page
// moved.
function altText(html: string): string {
  const values: string[] = [];
  for (const m of html.matchAll(/(?<![-\w])alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    values.push(decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").replace(/\s+/g, " ").trim());
  }
  return values.join("\u0000");
}

// Every attribute EXCEPT alt, tag by tag, in document order.
//
// The other three signals are blind to attributes — `tagShape` reads names only, and
// `visibleText` throws attribute values away — which left the two corrections that matter
// most invisible: an `href` the model re-typed inexactly, which is the entire reason the
// links pass exists (links.ts asks for "exactly that URL — without changing anything else
// about the page", and a model that obeys changes one attribute), and the accessibility
// attributes agents/page.md requires by name — `<th scope>`, `aria-describedby`, an
// `aria-label` on a symbol marker, `for`/`id`, `lang`, `colspan`. A pass that fixes exactly
// what it was asked to fix must not read as a pass that changed nothing.
//
// `alt` is excluded because it has its own signal, and keeping them apart is what makes
// "nothing but the descriptions moved" a thing this module can say. Each tag's attributes
// are sorted, because their order carries no meaning and a model re-emitting its own tag
// may reorder them; values are whitespace-collapsed and entity-decoded for the reason the
// text is — a page re-typed must not register as a page changed.
//
// Tags are joined on a separator an attribute value cannot contain, for the reason `altText`
// is: on a space, an attribute moved from one tag to the next would compare equal to the
// original, and the tag boundary is the only thing that says otherwise.
//
// Comments are removed first, with the same pattern `visibleText` uses: `TAG` matches
// `<!-- … -->` too, and the pair scanner below would then harvest every word in the comment
// body as an attribute name — so a rewrite of `<!-- continued from previous page -->` would
// land in `effects.attrs`, the bucket that is documented as a re-typed `href` or a missing
// `<th scope>`. A comment is not content anywhere else in this module and is not one here.
function attrText(html: string): string {
  const tags: string[] = [];
  for (const tag of html.replace(COMMENT, " ").match(TAG) ?? []) {
    const inner = tag.replace(/^<\/?[a-z][a-z0-9]*/i, "").replace(/\/?>?$/, "");
    const pairs: string[] = [];
    for (const m of inner.matchAll(/([a-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi)) {
      const name = m[1].toLowerCase();
      if (name === "alt") continue;
      pairs.push(`${name}=${decodeEntities(m[2] ?? m[3] ?? m[4] ?? "").replace(/\s+/g, " ").trim()}`);
    }
    tags.push(pairs.sort().join(" "));
  }
  return tags.join("\u0000");
}

// The four ways a correction can differ from what it corrected, plus the sizes. Not a
// partition: a re-render that rebuilds a table changes text and structure both, and
// only `alt_changed` alone means "nothing but the descriptions moved". All four false
// together means the page is materially the one it was given, whatever the two strings
// look like.
export interface CorrectionEffect {
  chars_before: number;
  chars_after: number;
  // The same two sizes with the markup taken out: how many characters a READER receives.
  //
  // `chars_*` cannot answer the question the correction accounting is actually asked, which
  // is whether a page that failed its fidelity check had arrived WRONG or merely arrived
  // unpolished (issue #166: "some way to tell a cosmetic discrepancy from a lost-content
  // one, so a 71% fail rate can be read as 71% of pages had something to fix"). A correction
  // that adds `<th scope="col">` to eight cells and one that brings back a lost table row
  // both grow the fragment by a few hundred characters, and `text_changed` says only that
  // some word somewhere moved.
  //
  // These two separate them without a threshold and without a model call: markup-only work
  // leaves them equal, restored content raises `after`, and dropped content lowers it. The
  // difference between this delta and the `chars_*` delta is the markup the pass added. Left
  // as sizes rather than folded into a verdict because "how much prose may a legitimate
  // correction move" is exactly the kind of number `CORRECTION_SHRINK_FLOOR` needed 265
  // samples to place, and there is no corpus for this one yet — the diagnostics fold counts
  // the direction only (grew, shrank, or the same length), which needs no band.
  text_chars_before: number;
  text_chars_after: number;
  text_changed: boolean;
  alt_changed: boolean;
  attrs_changed: boolean;
  structure_changed: boolean;
}

export function correctionEffect(before: string, after: string): CorrectionEffect {
  // Held rather than recomputed inside the comparison: the same two strings answer both
  // `text_changed` and the sizes, and a second pass over a 20 kB fragment to ask a second
  // question about it is work for nothing.
  const textBefore = visibleText(before);
  const textAfter = visibleText(after);
  return {
    chars_before: before.length,
    chars_after: after.length,
    text_chars_before: textBefore.length,
    text_chars_after: textAfter.length,
    text_changed: textBefore !== textAfter,
    alt_changed: altText(before) !== altText(after),
    attrs_changed: attrText(before) !== attrText(after),
    structure_changed: tagShape(before) !== tagShape(after),
  };
}

// Did the pass change the page at all? Read off the effect rather than off string
// identity, because a model that re-indents its own output, or writes `&` where it wrote
// `&amp;`, returns a different string and the same page.
export function changedAnything(e: CorrectionEffect): boolean {
  return e.text_changed || e.alt_changed || e.attrs_changed || e.structure_changed;
}

// How much of a page a correction may lose before it is refused outright, as a divisor: a
// reply shorter than a quarter of what it was asked to correct did not correct that page.
//
// Read off the 265 corrections in the bench logs that record both sizes. Every legitimate one
// lands between 0.62 and 2.32 times the page it replaced (median 0.995 — corrections mostly
// re-render a page at about its own size, and the ones that grow are restoring something).
// Below that, two: a 3-character reply against an 8,334-character page, and a 2,253-character
// reply against a 13,695-character one. Both are issue #170 — a reasoning model's scratch
// template and the first of four drafts — and both were logged `result: "kept"`, so both pages
// left in the delivered document as a sentence's worth of markup. A quarter sits an order of
// magnitude clear of the first and a factor of 2.5 clear of the smallest real correction, which
// is as much room as a threshold read off 265 samples deserves.
//
// util/json.ts now reads the right envelope out of both of those replies, so this catches
// nothing in the corpus it was drawn from. That is the point of having it: choosing the best
// candidate is a guess about what the model meant, and this is the floor under the guess —
// whatever the parser picked, a pass that returns a fraction of the page does not get to
// replace it. A correction is single-shot, so what it returns is what the document keeps.
//
// What it cannot tell is which side of the comparison was wrong. The same ratio comes out of a
// page that was BLOATED plus a correction that fixed it — degenerate repetition, a row or a
// paragraph emitted dozens of times, is a real vision-model failure and one the Feedback Agent
// flags — and on such a page this refuses the fix and ships the repeated version. Distinguishing
// the two means deciding which content is redundant, which is a judgement about the page rather
// than about its size, and nothing in the 265 corrections shows the shape to calibrate it on.
// So it is left as the cheap comparison, and `page_correction_rejected` carries both sizes: a
// correction refused for a shrink that was the point of it is visible in the log, which is where
// the evidence for anything cleverer would have to come from.
export const CORRECTION_SHRINK_FLOOR = 4;

// Did the correction lose the page rather than correct it?
export function destroyedPage(before: string, after: string): boolean {
  return after.length * CORRECTION_SHRINK_FLOOR < before.length;
}

// How many measurement-only re-verifications a batch of pages may buy.
//
// One, because the point is a rate across runs rather than a verdict on any one page,
// and the cost is the thing under investigation: re-verifying every corrected page
// would add a Feedback Agent call per correction — on the Meta run, 25 of them, which
// would roughly double the 24% share the issue is asking about. A sample of one per run
// costs ~1% of a document and answers the question over a week of them.
//
// The links path already re-verifies for its own reasons and that verdict is logged the
// same way, so a run whose corrections were link-driven contributes more than one.
export const RECHECKS_PER_BATCH = 1;

export interface RecheckSampler {
  left: number;
}

export function recheckSampler(): RecheckSampler {
  return { left: RECHECKS_PER_BATCH };
}

// Take the batch's sample slot, if it is still there. Claimed SYNCHRONOUSLY and before
// the call it authorizes, because pages are extracted concurrently: a check that
// awaited first would let several pages each see a free slot and every corrected page
// would be re-verified, which is the cost this bounds.
export function claimRecheck(sampler: RecheckSampler): boolean {
  if (sampler.left <= 0) return false;
  sampler.left -= 1;
  return true;
}
