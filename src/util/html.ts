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
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

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
