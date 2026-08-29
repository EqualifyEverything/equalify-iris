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
// **What it declines.** A `<main>` with no matching `</main>`, or a stray `</main>` matching
// no start tag, is left exactly as it is. There is no correct edit for half a wrapper — the
// element's extent is whatever the parser decides, and both possible guesses move content
// into or out of a landmark. That residue is what the two axe rules enabled by name in
// lint.ts are for (`landmark-no-duplicate-main`, `landmark-main-is-top-level`): this rewrite
// is a string edit and the gate is the check that it worked.

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
  // Tags left alone because they had no partner. Not a count of pairs — it is a count of
  // TAGS, and it is the number that says this function did not finish the job, so the gate
  // is expected to report a duplicate main when it is above zero.
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
  let pos = 0;
  while (pos < attrs.length) {
    const m = ATTR_STEP.exec(attrs.slice(pos));
    // Nothing an attribute can begin with: step over one character and keep looking. It cannot
    // land inside a value, because a value is consumed whole as part of its own attribute.
    if (!m || m[0].length === 0) {
      pos++;
      continue;
    }
    const [whole, gap, name, dq, sq, bare] = m;
    // The FIRST `role` is the only one a parser sees, so this stops at it either way: a second
    // spelling is already dead, and a valueless `role` has no `main` token to drop.
    if (name!.toLowerCase() === "role") {
      const value = dq ?? sq ?? bare;
      if (value === undefined) return attrs;
      const tokens = value.split(/\s+/).filter((t) => t.length > 0);
      const kept = tokens.filter((t) => t.toLowerCase() !== "main");
      if (kept.length === tokens.length) return attrs;
      const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
      const replacement = kept.length === 0 ? "" : `${gap}role=${quote}${kept.join(" ")}${quote}`;
      // Spliced by offset rather than by `replace`, so a `$` in a surviving token is a character
      // and not a `$&`-style back-reference.
      return attrs.slice(0, pos) + replacement + attrs.slice(pos + whole!.length);
    }
    pos += whole!.length;
  }
  return attrs;
}

export function stripNestedMain(html: string): MainStrip {
  if (!ANY_MAIN.test(html)) return { html, unwrapped: 0, downgraded: 0, declined: 0 };
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
      // A `</main>` closing nothing. Left as it is, and counted.
      declined++;
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
  // Start tags that were never closed.
  declined += open.length;
  if (edits.length === 0) return { html, unwrapped, downgraded, declined };
  edits.sort((a, b) => b.at - a.at);
  let out = html;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at + e.length);
  return { html: out, unwrapped, downgraded, declined };
}
