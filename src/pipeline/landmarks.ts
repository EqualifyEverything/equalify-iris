// Take a `<main>` out of body content, because the delivered document already has one
// (issue #251).
//
// `wrapDocument` (assembly.ts) puts the assembled body inside `<main>`. A page that emits
// its own therefore ships a `<main>` inside a `<main>`, which is not a stylistic quibble:
// `main` is the landmark a screen-reader user jumps to in order to skip the furniture, and
// a document with two of them has no such place. Measured across the bench's 108 scored
// page answers, 18% contained one — every model in the lineup, at rates that do not
// separate them (5 of 18 for the most, 2 of 18 for the least). When six models fail the
// same way at the same rate, the instruction is what is missing, not the model: so
// `agents/page.md` now says the shell exists, and this is the part that does not depend on
// a model reading it. Same division of labour as `anchors.ts` and `roles.ts`.
//
// It runs on the JOINED body rather than per fragment, and everywhere a body can arrive
// from: the fresh join, a body resumed from an earlier run, and the Copy Editor's rewrite —
// which retypes the whole document from a prompt that never mentions `<main>` either, so it
// is a reintroduction path in its own right.
//
// **Two outcomes, chosen by whether the tag carries anything.** A bare `<main>` has its tags
// removed and its children promoted, which is the whole fix. A `<main lang="ko" id="p3">`
// becomes a `<div>` with those attributes, because both of those are load-bearing and would
// be silently lost by unwrapping: `bodyLang` derives the document's root language from the
// top-level elements of the body, and an `id` is what an `href="#p3"` elsewhere in the
// document resolves to. A `<div>` is generic — no landmark, no role, nothing announced — so
// the defect is gone either way, and the second form keeps a wrapper nobody needed rather
// than dropping an attribute somebody did.
//
// **A body with no `<main>` comes back byte-identical**, which the review loop depends on:
// it decides a round changed nothing by comparing two body strings (`review_converged`).
//
// **What it declines.** A `<main>` with no matching `</main>` is left exactly as it is. There
// is no correct edit for half a wrapper — the element's extent is whatever the parser decides,
// and both possible guesses move content into or out of a landmark. That residue is what the
// two axe rules enabled by name in lint.ts are for (`landmark-no-duplicate-main`,
// `landmark-main-is-top-level`): this rewrite is a string edit and the gate is the check that
// it worked.
//
// **The other half is not declined but deleted.** A stray `</main>` closing nothing is dead
// markup a parser discards, so there is nothing to weigh — and it is the one unpaired shape
// the gate is blind to, because inside the shell it closes the document's own `<main>` early
// and everything after it is delivered outside the landmark with no rule reporting a thing.
// Counted as `dropped`.

// Start tag or end tag, in one pass so they can be paired in document order. Attributes are
// read as text-or-quoted-string, so a `>` inside an attribute value does not end the tag
// early; the alternation is unambiguous (`[^>"']` cannot begin a quoted branch), so it
// cannot backtrack pathologically. `\b` after the name is what keeps `<mainsail>` out of it.
const MAIN_TAG = /<main\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<\/main\s*>/gi;
// Cheap pre-check so an ordinary document does no scanning work. Deliberately loose — it
// matches the word in prose too, and a false positive costs the scan below, which then finds
// no tag to edit.
const ANY_MAIN = /<\/?main\b/i;
// Comments, so the scan can ignore what is inside them. A `<main>` in a comment is not an
// element: axe cannot see it, so counting it as `declined` would put a `page_main_stripped`
// line in the run log promising a violation the gate will never report, and editing inside one
// (a commented `</main>` paired with a real start tag) is not an edit any parser would agree
// with. This body carries comments by design — `@page-failed` marks a page extraction lost —
// so it is a live shape and not a hypothetical one.
const COMMENT = /<!--[\s\S]*?-->/g;
// One attribute at the front of what is left of the attribute text: leading whitespace,
// a name, and optionally a value in any of the three quoting styles. Anchored and stepped
// through from the start of the tag rather than searched for, because a SEARCH for `role`
// finds one inside another attribute's value and splices it out of that value —
// `<main title="see role=main note">` would come back with a `title` reading "see note".
// That is the same hazard `attrValue` in assembly.ts avoids by reading `lang` this way, and
// the reason to reuse its shape here rather than invent a second dialect for the same job.
// The whitespace is captured so the attribute can be removed WITH its separator instead of
// leaving `<div  id="x">`.
const ATTR_STEP = /^(\s*)([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/;

export interface MainStrip {
  html: string;
  // Pairs whose tags were removed outright (the tag carried no attributes).
  unwrapped: number;
  // Pairs rewritten to `<div>` because the start tag carried attributes worth keeping.
  downgraded: number;
  // End tags with no start tag, deleted. See the argument at the pop below: this is the one
  // unpaired shape with an unambiguous edit, and the only one the gate cannot report.
  dropped: number;
  // START tags left alone because nothing closed them. It is the number that says this
  // function did not finish the job, so the gate is expected to report a duplicate main when
  // it is above zero.
  declined: number;
}

// An explicit `role="main"` is dropped on the way to `<div>`, and only that token: keeping it
// would put the landmark straight back on the element the tags were rewritten to remove, which
// is the one attribute a downgrade cannot preserve and still be a fix. Any other role the page
// chose is left — `<main role="region">` becomes a `<div role="region">`, which is a region and
// not a second main, so it is no longer this function's business.
//
// Note the asymmetry with a `role="main"` on an element that was never a `<main>`: a
// `<div role="main">` in a fragment is the same defect and is NOT touched here, because
// deleting a role a model chose on an element whose own semantics do not cover it is the
// judgement roles.ts deliberately refuses to make (there it would leave a bare `<div>` with
// nothing marking it at all). The enabled axe rules report that shape instead, and the review
// loop is what answers it.
function attrsForDiv(attrs: string): string {
  // Every `role` the tag spells, with the span each one occupies — not just the first, because
  // of what removing the first one does to the others (below).
  const roles: { at: number; length: number; gap: string; dq?: string; sq?: string; bare?: string }[] = [];
  let pos = 0;
  while (pos < attrs.length) {
    const m = ATTR_STEP.exec(attrs.slice(pos));
    // Nothing an attribute can begin with: step over one character and keep looking. It cannot
    // land inside a value, because a value is consumed whole as part of its own attribute.
    if (!m || m[0].length === 0) {
      pos++;
      continue;
    }
    if (m[2]!.toLowerCase() === "role") {
      roles.push({ at: pos, length: m[0].length, gap: m[1]!, dq: m[3], sq: m[4], bare: m[5] });
    }
    pos += m[0].length;
  }
  if (roles.length === 0) return attrs;
  // The effective role is the first spelling, which is the one a parser reads. A valueless
  // `role` has no `main` token in it, and neither has `role="region"`: either way there is
  // nothing to drop and the tag keeps its attribute text exactly.
  const first = roles[0]!;
  const value = first.dq ?? first.sq ?? first.bare;
  const tokens = value === undefined ? [] : value.split(/\s+/).filter((t) => t.length > 0);
  const kept = tokens.filter((t) => t.toLowerCase() !== "main");
  if (kept.length === tokens.length) return attrs;
  const quote = first.dq !== undefined ? '"' : first.sq !== undefined ? "'" : "";
  const replacement = kept.length === 0 ? "" : `${first.gap}role=${quote}${kept.join(" ")}${quote}`;
  // And every LATER spelling goes with it. A parser reads only the first, so dropping the rest
  // changes nothing it would have announced — while LEAVING them promotes one: taking a
  // `role="main"` out in front of a `role="banner"` makes the banner live, so an element whose
  // page announced a main arrives announcing a banner instead, inside the shell's `<main>`,
  // where `landmark-banner-is-top-level` is `best-practice` and correctly not enabled, so
  // nothing reports it. Spliced from the end backwards so the first role's offset stays valid.
  let out = attrs;
  for (const r of roles.slice(1).reverse()) out = out.slice(0, r.at) + out.slice(r.at + r.length);
  // Spliced by offset rather than by `replace`, so a `$` in a surviving token is a character
  // and not a `$&`-style back-reference.
  return out.slice(0, first.at) + replacement + out.slice(first.at + first.length);
}

export function stripNestedMain(html: string): MainStrip {
  if (!ANY_MAIN.test(html)) return { html, unwrapped: 0, downgraded: 0, dropped: 0, declined: 0 };
  // One edit per tag, collected with absolute offsets and applied from the end backwards so
  // earlier offsets stay valid.
  type Edit = { at: number; length: number; text: string };
  const edits: Edit[] = [];
  // Open start tags, innermost last. `<main>` cannot legally contain another one, but a model
  // is not a validator, and a depth-tracking pair-up is what makes the inner one's `</main>`
  // stop belonging to the outer one.
  const open: { at: number; length: number; attrs: string }[] = [];
  let unwrapped = 0;
  let downgraded = 0;
  let dropped = 0;
  let declined = 0;
  // Where the comments are, so a tag inside one can be passed over.
  const comments: { at: number; end: number }[] = [];
  COMMENT.lastIndex = 0;
  for (let c = COMMENT.exec(html); c; c = COMMENT.exec(html)) comments.push({ at: c.index, end: c.index + c[0].length });
  const commented = (at: number): boolean => comments.some((c) => at >= c.at && at < c.end);
  MAIN_TAG.lastIndex = 0;
  for (let m = MAIN_TAG.exec(html); m; m = MAIN_TAG.exec(html)) {
    if (commented(m.index)) continue;
    const isStart = m[1] !== undefined;
    if (isStart) {
      open.push({ at: m.index, length: m[0].length, attrs: m[1]! });
      continue;
    }
    const start = open.pop();
    if (!start) {
      // A `</main>` closing nothing, which is the one unpaired shape with an unambiguous edit:
      // an end tag carries no content, and a parser discards this one outright. It is also the
      // only unpaired shape the gate cannot report, and the most damaging: inside the shell it
      // closes the document's own `<main>` early, so everything after it is delivered OUTSIDE
      // the landmark, and no enabled rule sees that (the escape predates this file — a body
      // with a stray `</main>` ships the same way on `main` — but leaving it counted as
      // `declined` would promise a violation nobody can find). So it goes, and it is counted
      // apart from the tags that stay.
      edits.push({ at: m.index, length: m[0].length, text: "" });
      dropped++;
      continue;
    }
    if (start.attrs.trim() === "") {
      edits.push({ at: start.at, length: start.length, text: "" });
      edits.push({ at: m.index, length: m[0].length, text: "" });
      unwrapped++;
    } else {
      edits.push({ at: start.at, length: start.length, text: `<div${attrsForDiv(start.attrs)}>` });
      edits.push({ at: m.index, length: m[0].length, text: "</div>" });
      downgraded++;
    }
  }
  // Start tags that were never closed. Those DO stay: the element's extent is whatever the
  // parser decides, both guesses move content into or out of a landmark, and an unclosed
  // `<main>` is a duplicate the gate reports.
  declined += open.length;
  if (edits.length === 0) return { html, unwrapped, downgraded, dropped, declined };
  edits.sort((a, b) => b.at - a.at);
  let out = html;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.length);
  return { html: out, unwrapped, downgraded, dropped, declined };
}
