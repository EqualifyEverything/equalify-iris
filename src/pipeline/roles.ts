// Drop a deprecated ARIA role from the element that already says what it said (issue #187).
//
// ARIA deprecates exactly three roles — `directory`, `doc-biblioentry`, `doc-endnote` — and
// axe fails a document that uses one (`aria-deprecated-role`, minor). All three were folded
// into list semantics, so each one has a host element whose implicit role is already the
// role: a `<li>` is a `listitem` to a screen reader whether or not it also claims to be a
// `doc-endnote`, and a `<ul>` is a `list` whether or not it claims to be a `directory`.
// Removing the attribute there changes nothing a reader is given and removes the violation.
//
// Why this exists at all, when the page prompt now says not to emit these: round 8 of the
// benchmark shipped `<li id="p3-fn-1" role="doc-endnote">` inside a correct
// `<ol role="doc-endnotes">`. The prompt's FOOTNOTES rule prescribed the markup in detail
// and said nothing about roles, so the model reached for the DPUB pair on its own and picked
// up the deprecated half. Teaching the prompt is the fix; this is the part that does not
// depend on a model obeying it. It is the same division of labour as `anchors.ts`: the
// prompt asks for footnote ids, and the join makes them unique regardless.
//
// **Only where the role is redundant.** A `<div role="doc-endnote">` is not touched, and
// that is deliberate rather than an omission: deleting the role there would leave a plain
// `<div>` with nothing at all marking it as a note, trading a reported violation for a
// silent loss. DPUB's own remedy for that element is to make it a list item — a restructure,
// which is a model's job and not an attribute rewrite's. So it keeps failing the gate, which
// is the correct outcome for it, and the case actually observed is fixed here for good.
//
// **A document with nothing to strip comes back byte-identical.** This rewrites the matched
// `role` attribute inside the matched start tag and touches nothing else — no parse, no
// reserialization. That matters twice over: the review loop decides a round changed nothing
// by comparing two body strings (`review_converged`), and `anchors.ts` records the pages it
// declined to reserialize precisely because a round trip through a DOM can lose markup.

// Each deprecated role, with the elements whose implicit role already covers it. `menu` is
// here with the lists because `directory` maps to `list` and `<menu>` is a list element in
// HTML; `<dl>` is not, so a `role="directory"` on one is left to the gate.
const REDUNDANT_ON: Record<string, string[]> = {
  "doc-endnote": ["li"],
  "doc-biblioentry": ["li"],
  directory: ["ul", "ol", "menu"],
};

// Cheap pre-check so the ordinary document does no scanning work. Deliberately loose — it
// matches the role names anywhere, including in prose — because a false positive here only
// costs the scan below, which then finds nothing to change.
const ANY_DEPRECATED = /doc-endnote\b|doc-biblioentry\b|directory\b/i;

// A start tag, with its attributes read as text-or-quoted-string so a `>` inside an
// attribute value does not end the tag early. The alternation is unambiguous (`[^>"']`
// cannot start a quoted branch), so this cannot backtrack pathologically.
//
// Where it is fooled — by an unencoded `>` in an unquoted value, say — it ends the slice
// early and finds no `role` in it, so the strip is missed. It cannot mangle a tag it
// mis-sliced, because the only edit made is to a `role` attribute found INSIDE the slice.
const START_TAG = /<([a-z][a-z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;

// `role` in the attribute text: double-quoted, single-quoted, or bare. The leading
// whitespace is captured so the attribute can be removed WITH its separator when the last
// token goes, rather than leaving `<li  id="x">`.
const ROLE_ATTR = /(\s+)role\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

export interface RoleStrip {
  html: string;
  // One entry per attribute token removed, in document order, so `stripped.length` is the
  // node count axe would have reported and `new Set(stripped)` is which roles they were.
  stripped: string[];
}

export function stripDeprecatedRoles(html: string): RoleStrip {
  if (!ANY_DEPRECATED.test(html)) return { html, stripped: [] };
  const stripped: string[] = [];
  const out = html.replace(START_TAG, (tag, name: string, attrs: string) => {
    const m = ROLE_ATTR.exec(attrs);
    if (!m) return tag;
    const [whole, gap, dq, sq, bare] = m;
    const value = dq ?? sq ?? bare ?? "";
    // ARIA takes the first token it recognises, so a deprecated token after a good one is
    // already inert — removed anyway, because an inert token is still text in the file that
    // says the wrong thing about the element.
    const tokens = value.split(/\s+/).filter((t) => t.length > 0);
    const kept = tokens.filter((t) => {
      const hosts = REDUNDANT_ON[t.toLowerCase()];
      if (!hosts?.includes(name.toLowerCase())) return true;
      stripped.push(t.toLowerCase());
      return false;
    });
    if (kept.length === tokens.length) return tag;
    // The quoting style the page used is kept for the tokens that survive; a value that
    // loses every token loses the attribute and the whitespace that introduced it.
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
    const replacement = kept.length === 0 ? "" : `${gap}role=${quote}${kept.join(" ")}${quote}`;
    // Replaced through a function so a `$` in a surviving token is a character rather than a
    // `$&`-style reference, and searched from the start of the tag — where `whole` begins with
    // whitespace and `<name` has none, so the first hit is the attribute just matched.
    return tag.replace(whole, () => replacement);
  });
  return { html: out, stripped };
}
