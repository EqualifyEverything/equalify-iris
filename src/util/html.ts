// Named and numeric character references, decoded. Shared because the same
// decoding is needed on both sides of a link comparison: poppler writes XML entities
// into the hrefs it reports (`&amp;` in a query string), and the page agent writes
// them into the HTML it produces — so `?y=2026&q=1` and `?y=2026&amp;q=1` are the
// same URL, and a comparison that does not know that reports a link as missing while
// it sits in the document.
//
// Only the five XML entities are named here, plus `&#39;`. That is deliberate: this
// decodes attribute values and anchor text for comparison, not arbitrary prose, and
// the full HTML5 named-reference table (2000+ entries) is a dependency's worth of
// data for characters that do not change whether two URLs match. Numeric references
// cover the rest.
//
// Null-prototype, and that is load-bearing: a plain object literal answers
// `NAMED["constructor"]` with a function inherited from Object.prototype, so a URL
// containing the literal text `&constructor;` would decode to `function Object() {
// [native code] }` on one side of a comparison and stay written as it is on the
// other — turning a link that IS in the document into a reported miss, which is the
// exact failure this file exists to prevent.
const NAMED: Record<string, string> = Object.assign(Object.create(null), {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

// U+00AD SOFT HYPHEN, in every spelling a model can write it, including as a raw
// character. `&shy` without the semicolon is deliberately NOT matched: it is legal
// HTML5, but requiring the semicolon is what keeps this from eating the literal text
// `&shy` out of a page about HTML entities, and a model that omits it is a case nothing
// has produced. `&amp;shy;` is safe by construction — the `&` is consumed by `amp`, so
// there is no `&` immediately before `shy;` for this to match.
//
// Written as an escape and not as the character itself, because the character itself is
// invisible: a regex with one in it looks to the next reader like `/|&shy;/`.
const SOFT_HYPHEN = /\u00ad|&shy;|&#0*173;|&#x0*ad;/gi;

// Take soft hyphens out of markup a model wrote, and say how many there were.
//
// There is no page where one is the right answer, which is what makes this a code repair
// rather than a prompt clause (issue #334). `agents/page.md` already forbids the thing
// that produces them — a word the printing broke at the end of a LINE is written whole,
// the break is not carried into the markup — and three models from three labs carry it
// anyway. What ships when they do is worse than a visible hyphen in one respect: nothing
// renders, so a page reads as clean, while find-in-page silently fails. A reader
// searching a delivered document for `Insurance` does not match `Insur&shy;ance`, and the
// words this lands on are table row labels and column headings, which are the words a
// reader searches for.
//
// The count is returned rather than logged here so the caller names the reply it came
// from: the same character from the first render, from the correction pass and from a
// specialist are three different facts about three different calls.
export function stripSoftHyphens(html: string): { html: string; removed: number } {
  let removed = 0;
  const out = html.replace(SOFT_HYPHEN, () => {
    removed++;
    return "";
  });
  return { html: out, removed };
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    const key = ref.toLowerCase();
    if (NAMED[key] !== undefined) return NAMED[key];
    // A malformed code point (`&#xZZ;`, or one past the Unicode range) throws in
    // String.fromCodePoint; leave it as written rather than failing the caller.
    try {
      if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
      if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    } catch {
      return whole;
    }
    return whole;
  });
}
