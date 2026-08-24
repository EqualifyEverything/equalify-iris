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

function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(TAG, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
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
function attrText(html: string): string {
  const tags: string[] = [];
  for (const tag of html.match(TAG) ?? []) {
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
  text_changed: boolean;
  alt_changed: boolean;
  attrs_changed: boolean;
  structure_changed: boolean;
}

export function correctionEffect(before: string, after: string): CorrectionEffect {
  return {
    chars_before: before.length,
    chars_after: after.length,
    text_changed: visibleText(before) !== visibleText(after),
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
