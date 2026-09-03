import axe from "axe-core";

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

// Cheap pre-check so the ordinary document does no scanning work. It looks for the role name
// in something shaped like a `role` attribute rather than for the name alone: `directory` is an
// ordinary English word and `doc-endnote` appears in prose about this very rule, and a
// transcribed page that mentions a staff directory should not pay for a scan of the whole
// joined body. Still only a pre-check — it matches `role=directory` written in text too, and a
// false positive costs the scan below, which then finds no tag to change.
const ANY_DEPRECATED = /role\s*=\s*["']?[^"'>]*(?:doc-endnote|doc-biblioentry|directory)\b/i;

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
//
// Non-global, so only the FIRST `role` in a start tag is considered — which is the only one
// that exists as far as anything downstream is concerned. The HTML parser drops a repeated
// attribute and keeps the first, so `<li role="listitem" role="doc-endnote">` is
// `<li role="listitem">` in the tree, axe never sees the deprecated one, and rewriting it here
// would edit a string nobody reads. (anchors.ts's source scan takes the first of a repeated
// attribute for the same reason.)
const ROLE_ATTR = /(\s+)role\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

export interface RoleStrip {
  html: string;
  // One entry per attribute token removed, in document order, so `new Set(stripped)` is which
  // roles they were. Token-wise rather than element-wise: an element carrying two deprecated
  // tokens contributes two entries, which is why `nodes` is counted separately.
  stripped: string[];
  // Elements edited, which is the figure `aria-deprecated-role` would have reported. The same
  // as `stripped.length` for anything real — two deprecated roles on one element is not markup
  // a page agent produces — and the two are kept apart so the log's `nodes` means nodes.
  nodes: number;
}

export function stripDeprecatedRoles(html: string): RoleStrip {
  if (!ANY_DEPRECATED.test(html)) return { html, stripped: [], nodes: 0 };
  const stripped: string[] = [];
  let nodes = 0;
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
    nodes++;
    // The quoting style the page used is kept for the tokens that survive; a value that
    // loses every token loses the attribute and the whitespace that introduced it.
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
    const replacement = kept.length === 0 ? "" : `${gap}role=${quote}${kept.join(" ")}${quote}`;
    // Replaced through a function so a `$` in a surviving token is a character rather than a
    // `$&`-style reference, and searched from the start of the tag — where `whole` begins with
    // whitespace and `<name` has none, so the first hit is the attribute just matched.
    return tag.replace(whole, () => replacement);
  });
  return { html: out, stripped, nodes };
}

// Drop a role that is not an ARIA role at all (issue #345).
//
// The observed case is `role="doc-footnotes"`, which does not exist: DPUB defines `doc-footnote`
// for one note and `doc-endnotes` for a collection, and never a plural of the first. The shipped
// page model emitted it on 3 of the 22 occasions it had to name that role, axe reports
// `aria-roles` at **critical** — the most severe thing the gate says about any document Iris has
// produced — and it reached a delivered `output.html` on a round where the lint had degraded to
// did not run. Both models in the loop passed it every time, twice on pages they had failed for
// other reasons and bought a correction for, once on a page failed for an accessibility finding
// specifically. So neither the prompt nor the checker is the part that can be relied on here.
//
// **This is the easiest case in the class, and that is the argument for taking it generally.** The
// strip above has to name three roles and the elements they are redundant on, because a
// deprecated role still MEANS something and deleting it can leave an element with nothing saying
// what it was. An invalid role means nothing to anybody: assistive technology already ignores it
// and computes the element's implicit role, which is exactly what the element computes to with the
// attribute gone. So removing it cannot lose a reader anything, on any element, and no host table
// is needed. It also closes the class rather than the instance — the next model to invent
// `doc-footer` or `doc-notes` is covered by code that was written before it existed.
//
// What it does NOT do is name the block. A stripped `<section role="doc-footnotes">` is a
// `<section>` with no accessible name, which is compliant and anonymous, and the model's intent
// was reasonable. That half is the FOOTNOTES rule in `agents/page.md`, which now says the plural
// does not exist and gives the shapes that work.
//
// It is also not a repair for the JSON-escaping leak (#233/#234/#257), which puts things like
// `\"doc-pagebreak\"` in a `role`. That shape is DECLINED rather than stripped — see the guard in
// the scan — and it should be: the leak's other symptoms are the ones worth having, and they are
// untouched. The marker's `aria-label` still announces the wrong text, its `id` is still a dead
// target, `LintResult.malformedAttributes` still counts the debris and names it, and the gate still
// reports the role. A clean `aria-roles` column would not have made that a clean document.

// Whether axe will accept a token in a `role`, asked of axe rather than written down here. The set
// is finite but long (120 names) and moves with the spec, and a list of it in this file would be a
// second opinion about what the gate accepts: stale by one release, it either strips a role axe
// considers valid or delivers one it does not. Asking axe makes the guard and the gate the same
// judgement by construction.
//
// It is not QUITE the same function, and the one place it differs is asked about at the call below:
// `isValidRole` is case-sensitive and the `aria-roles` rule folds a role token, so this predicate
// alone calls `DOC-ENDNOTES` invalid on a document the gate passes.
//
// Abstract roles (`roletype`, `widget`, `section`, …) are invalid to use, and `isValidRole`
// says so with its default arguments — which is the reading the gate takes, and the reason the
// probe below asks about one.
//
// **This throws on module load rather than degrading**, which is deliberate and is the #164
// lesson: a check that cannot run must not report the answer a passing document gives. If the
// oracle were missing and this file went on returning "nothing invalid found", every invalid role
// would ship with a log line saying the document was clean. The only thing that can break the
// oracle is an axe-core upgrade, which is a deliberate change with `npm test` in front of it, so
// the failure lands on whoever makes it rather than on a user's document.
const isValidRole: (role: string) => boolean = (() => {
  const ask = (axe as { commons?: { aria?: { isValidRole?: (role: string) => boolean } } }).commons?.aria?.isValidRole;
  // One probe each way, because a predicate that answers `true` to everything and one that
  // answers `false` to everything are both catastrophic here and neither is detectable from one
  // question: all-true delivers every invented role, all-false strips `doc-endnotes` and
  // `doc-pagebreak` out of every document Iris assembles.
  if (typeof ask !== "function" || !ask("doc-endnotes") || ask("doc-footnotes") || ask("roletype")) {
    throw new Error(
      "axe-core does not answer isValidRole as this build expects, so src/pipeline/roles.ts cannot " +
        "tell an invented role from a real one. Fix the oracle rather than removing the check: " +
        "returning 'nothing invalid' would ship every invalid role with a clean log line. " +
        "test/invalid-roles.test.ts pins these probes and what each of them catches.",
    );
  }
  return ask;
})();

// Cheap pre-check. Unlike `ANY_DEPRECATED` this cannot name what it is looking for — any role at
// all might be invalid — so it only asks whether the document has a `role` attribute anywhere.
// That is true of most documents Iris assembles, because the page marker carries
// `role="doc-pagebreak"`, so the scan below usually runs. It is one pass of the same start-tag
// regex the strip above uses, on a body that several other passes already walk.
const ANY_ROLE = /role\s*=/i;

// A recorded name is cut to this, because unlike the three deprecated names these are unbounded
// text out of a user's document and this field is logged. The longest name in axe's whole role
// table is `doc-acknowledgments` at 19 characters, so anything reaching this cut is not a
// misspelled role but a value that is not a name at all, and its first characters are enough to
// recognise that.
const NAME_CHARS = 40;

export interface InvalidRoleStrip {
  html: string;
  // One entry per token removed, in document order, cut to NAME_CHARS each — so `new Set(stripped)`
  // is which names were invented. Case as written, because `DOC-FOOTNOTES` and `doc-footnotes` are
  // evidence about different mistakes.
  stripped: string[];
  // Elements edited, which is the figure `aria-roles` would have reported for the tokens that went.
  // Not the same as `stripped.length` where one element carried two invented names.
  nodes: number;
}

export function stripInvalidRoles(html: string): InvalidRoleStrip {
  if (!ANY_ROLE.test(html)) return { html, stripped: [], nodes: 0 };
  const stripped: string[] = [];
  let nodes = 0;
  const out = html.replace(START_TAG, (tag, _name: string, attrs: string) => {
    const m = ROLE_ATTR.exec(attrs);
    if (!m) return tag;
    const [whole, gap, dq, sq, bare] = m;
    // An UNQUOTED value that the scan did not read to its end, which means the next character is a
    // quote the value ran into. This pass declines the whole tag there, and that decline is load
    // bearing rather than tidiness: the escaping leak (#233/#234/#257) delivers
    // `<hr role=\"doc-pagebreak\" …>`, where the unquoted value reads as the single character `\`.
    // Removing a "token" that is one character out of the middle of an attribute leaves
    // `<hr"doc-pagebreak\" …>` — markup mangled worse than the violation it was fixing. The strip
    // above cannot reach this case because it only ever removes one of three names it knows, and a
    // stray `\` is not one of them; this pass removes everything it does not recognise, so it needs
    // the guard the other does not.
    if (bare !== undefined) {
      const next = attrs.slice(m.index + whole.length, m.index + whole.length + 1);
      if (next !== "" && !/\s/.test(next)) return tag;
    }
    const value = dq ?? sq ?? bare ?? "";
    const tokens = value.split(/\s+/).filter((t) => t.length > 0);
    const kept = tokens.filter((t) => {
      // Asked in lower case, because that is the question the gate asks and the one a browser
      // answers. `isValidRole` on its own is case-SENSITIVE — it rejects `DOC-ENDNOTES` — while
      // `aria-roles` passes that document and HTML-AAM matches a role token ASCII
      // case-insensitively, so an oracle asked about the token as written disagrees with both. It
      // disagrees in the expensive direction: `role="DOC-ENDNOTES"` is a real landmark on a real
      // footnote list, and this pass would have deleted it while the gate said the document was
      // fine. Recorded as written, though — `DOC-FOOTNOTES` and `doc-footnotes` are evidence about
      // different mistakes, and only one of them is about the plural.
      if (isValidRole(t.toLowerCase())) return true;
      stripped.push(t.slice(0, NAME_CHARS));
      return false;
    });
    if (kept.length === tokens.length) return tag;
    nodes++;
    // A value with one good token and one invented one already computed to the good one — ARIA
    // takes the first token it recognises — so this case is not a violation the gate reported and
    // the edit changes nothing a reader is given. It is made anyway, for the reason the strip
    // above makes it: an inert token is still text in the file saying the wrong thing.
    const quote = dq !== undefined ? '"' : sq !== undefined ? "'" : "";
    const replacement = kept.length === 0 ? "" : `${gap}role=${quote}${kept.join(" ")}${quote}`;
    return tag.replace(whole, () => replacement);
  });
  return { html: out, stripped, nodes };
}
