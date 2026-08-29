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
// `role` in a start tag's attribute text, in any of the three quoting styles, with the
// leading whitespace captured so the attribute can be removed WITH its separator rather than
// leaving `<div  id="x">`. Non-global: only the first `role` exists as far as a parser is
// concerned, which is the same reading roles.ts and anchors.ts take of a repeated attribute.
const ROLE_ATTR = /(\s+)role\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

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
  const m = ROLE_ATTR.exec(attrs);
  if (!m) return attrs;
  const [whole, gap, dq, sq, bare] = m;
  const value = dq ?? sq ?? bare ?? "";
  const tokens = value.split(/\s+/).filter((t) => t.length > 0);
  const kept = tokens.filter((t) => t.toLowerCase() !== "main");
  if (kept.length === tokens.length) return attrs;
  const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
  const replacement = kept.length === 0 ? "" : `${gap}role=${quote}${kept.join(" ")}${quote}`;
  // Replaced through a function so a `$` in a surviving token is a character and not a
  // `$&`-style back-reference.
  return attrs.replace(whole, () => replacement);
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
  MAIN_TAG.lastIndex = 0;
  for (let m = MAIN_TAG.exec(html); m; m = MAIN_TAG.exec(html)) {
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
