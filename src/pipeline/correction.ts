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

// The same content when an ATTRIBUTE is what says so and the element name says nothing (issue #224,
// raised by the review of #221). The list above tests the name only, so `<div role="img"
// aria-label="A photo of the mayor"></div>` — a picture, announced as one, with a description a reader
// hears — read as an empty wrapper and carried nothing.
//
// Each role here says the element IS one of the things above, written on a name that says nothing:
// `img` and `graphics-*` are the picture when it is not an `<img>` or an `<svg>`, `math` is the
// equation, and `table`, `grid` and `treegrid` are the grid whose cells the list above already allows
// to be empty. The control roles are `<input>`, `<select>` and `<button>` the same way, plus the
// members of a composite widget — an `option`, a `tab`, a `menuitem` — which HTML has no entry in that
// list for and which are as much a thing to operate as the widget around them.
//
// This set is NOT a mirror of the element list, and two absences are where it would read as one.
// `figure` is out because `<figure>` is out: both are a wrapper, and an empty one hands a reader
// nothing — a role cannot make a box that holds nothing into a picture. `meter` and `progressbar` are
// out because `<meter>` and `<progress>` are, and a gauge with no value on it is the same empty box.
// `link` is out of this set for a different reason and handled below, because a link is content when a
// reader can hear what it is and not before, however it is spelled. Roles that say the element is not
// content are absent for the reason a page-break `<hr>` is: `presentation`, `none` and `separator`
// describe where something sat rather than what was on it, and `doc-pagebreak` is the one this prompt
// actually asks for — 18 of the corpus's 33 markup-spelled blanks are a bare page-break marker, so it
// being absent from here is what keeps every one of them a blank page rather than a reported failure.
//
// A whole token list is read rather than the first token, though ARIA takes the first valid one, for
// the reason the rest of this predicate leans that way: reading `img presentation` as a picture costs a
// glance at a page that was fine, and reading it as nothing drops a page with a picture on it.
const CONTENT_ROLE = new Set(
  (
    "img math table grid treegrid graphics-document graphics-symbol graphics-object " +
    "button checkbox radio switch slider spinbutton textbox combobox listbox option " +
    "menuitem menuitemcheckbox menuitemradio tab"
  ).split(" "),
);

// What an accessible name can be made of and still be no name, read AFTER `tagAttrs` has decoded the
// value. Three shapes, and each is here for its own reason (#229's review corrected the account this
// comment gave of the third):
//
//   - A character `trim` cannot see. `\s` covers a decoded space and a non-breaking one, so what is left
//     is the zero-width family — `&#x200B;` decodes to U+200B and survives `trim` as a name.
//   - A named reference `decodeEntities` leaves written: it names the five XML entities and nothing else
//     on purpose (src/util/html.ts), so `&nbsp;` arrives as six literal characters where `&#160;` arrives
//     as the space it means. One non-breaking space, two spellings, and without this they answered
//     opposite ways.
//   - The numeric spellings, which `decodeEntities` DOES resolve — so they reach this pattern only when
//     the value was encoded twice (`&amp;#160;` decodes to `&#160;`). Kept for that, not for the plain
//     form the bullet above covers.
const NAMELESS =
  /&(?:nbsp|ensp|emsp|thinsp|zwnj|zwj|#0*(?:32|160|8194|8195|8201|8203)|#x0*(?:20|a0|2002|2003|2009|200b));|[\u200b-\u200d\ufeff]/gi;

// One start tag's attributes, first value winning as a parser resolves a repeated one. The pair scan is
// `attrText`'s, and reusing it is what keeps `role` out of another attribute's VALUE: the pattern
// consumes a quoted value whole, so `<span title="see role=button">` yields one `title` and no role,
// where a search for `role=` across the whole tag found the prose inside the quotes — the same
// prose-about-markup hole `visibleText` and `attrText` close by reading comments and quotes rather than
// characters. The tag name is stripped first so `<a>` does not read as an attribute.
function tagAttrs(tag: string): Map<string, string> {
  const inner = tag.replace(/^<[a-z][a-z0-9]*/i, "").replace(/\/?>?$/, "");
  const attrs = new Map<string, string>();
  for (const m of inner.matchAll(/([a-z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi)) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

// Tag by tag, on the same scan `attrText` uses, because a role and a name on ONE element is the claim —
// a `role="img"` on a wrapper and an `aria-label` three tags later are two separate ones.
//
// The named link is the second shape, and the only one that needs a name to count: a link is the one
// interactive thing whose element name is not in `CONTENT_WITHOUT_TEXT` — an `<a>` is a wrapper as
// often as it is a control — so `<a href="#x" aria-label="Next"></a>` is something a reader can follow
// and hear named, and a bare `<a href="#x"></a>` is an empty box. `<area href>` is read as one too, the
// other interactive element the list above does not name. `role="link"` is read the same way rather than
// as one of the roles above, and it counts on ITS OWN — an `href` is what makes an `<a>` a link, and a
// role saying so is the author making the same claim without one, so `<a role="link" aria-label="Next">`
// and `<span role="link" aria-label="Next">` agree (#229's review found the first of those reading as
// nothing, which is the arm that loses a page). An accessible name anywhere else is not content:
// `<div aria-label="Main content">` labels a wrapper that holds nothing, and `<p aria-label="Blank
// page"></p>` is one of the corpus's own 33 blanks.
//
// EITHER attribute having a value is the whole test, rather than one falling back to the other: an
// `aria-labelledby` outranks an `aria-label` in the accessible-name computation, and reaching for the
// label first meant `<a href="#x" aria-label="" aria-labelledby="lbl">` — whose computed name is
// whatever `lbl` holds — read as nameless (#229's review). Asking whether either is non-empty makes the
// precedence moot, which is all a question about whether there is a name at all can honestly claim.
//
// An `aria-labelledby` pointing at an id the fragment does not contain is counted, though its
// accessible name computes to nothing. Deliberate, and priced by where this predicate is read: both
// callers (extraction.ts `blankDeclaration` and `renderPage`) use it to decide whether a reply's
// markup is a blank page or a REPORTED one, and neither delivers the fragment either way. So a
// dangling reference costs the same glance the rest of this leans toward, and refusing it would drop a
// link the model meant to put on the page. A name that is only whitespace is refused, because that is
// the author writing no name rather than pointing at one that has gone missing — and a space written as
// an ENTITY is the same no-name however it was spelled, which `trim` alone could not tell: `&#160;`
// decodes to a non-breaking space and vanishes, while `&nbsp;` survives `decodeEntities` as six literal
// characters and read as a name (#229's review). The five XML entities are all that function decodes on
// purpose, so the space spellings are undone here, where the question is what a reader would hear.
//
// Unreachable on today's prompts: `agents/page.md` asks for `<img>` and `<figure>` for a picture and
// never a `role="img"` wrapper, and the only role it mandates is the `doc-pagebreak` on the page-break
// marker, which is absent from the set above. It is here because the day a prompt allows one of these
// shapes is not a day anyone will be thinking about this file, and what it costs then is a page with a
// picture on it delivered empty, reported blank, with nothing in `pages_failed` to look for.
function attributeCarriesContent(markup: string): boolean {
  for (const tag of markup.match(TAG) ?? []) {
    if (tag.startsWith("</")) continue;
    const attrs = tagAttrs(tag);
    const roles = (attrs.get("role") ?? "").split(/\s+/).map((token) => token.toLowerCase());
    if (roles.some((role) => CONTENT_ROLE.has(role))) return true;
    if (roles.includes("link") || (/^<(?:a|area)\b/i.test(tag) && attrs.has("href"))) {
      const named = ["aria-labelledby", "aria-label"].some(
        (attr) => (attrs.get(attr) ?? "").replace(NAMELESS, " ").trim() !== "",
      );
      if (named) return true;
    }
  }
  return false;
}

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
  const markup = html.replace(COMMENT, " ");
  return CONTENT_WITHOUT_TEXT.test(markup) || attributeCarriesContent(markup);
}

// How many of each kind of structure a fragment holds. Exported for the review loop, on the
// same argument as `visibleText`: a round and a page correction measured by different scans
// could not be read against each other, and #174 asks for exactly that comparison.
//
// This is the signal #174's own measurement pointed at and neither path carries. Across the
// three review rounds whose input survived, LENGTH moved 1.6% while the structure counts moved
// 0.714–1.333 — one round dropping 5 of 7 lists and 13 of 47 list items, another gaining a
// table — so "how much of the document is left" and "how much of its structure is left" are
// different questions about the same round.
//
// The answer that argument was pointing at is NO, and the first round to log both is what
// settled it: the whole-body round in `runs-231` rewrote a 55-item `<dl>` into list items —
// `terms` 55 -> 3, `items` 113 -> 164, a ratio of 0.055 on the count — while its prose moved
// 0.3% and every word survived. That is the editor doing precisely what it is for, and there is
// no threshold on a structure count that both permits it and refuses a reply that came back with
// a fifth of the document. So `EDITOR_SHRINK_FLOOR` reads the visible text, and these counts stay
// what they were: the reading that says which KIND of thing a round moved, once a person is
// already looking at the round. Their instability in both directions on rounds that were working
// is the finding, not a defect in the counting.
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

// Every alt attribute's value, in document order. Kept as the values rather than one string
// because `altRelocations` below asks a question about a single description — which members it
// lists alongside which — and a join is exactly the boundary that question needs to keep.
//
// `\b` would open on the `alt` in `data-alt=` and in any other attribute ending in those
// three letters, so the name has to start on something that is not part of a longer one.
// What remains is prose that writes `alt="…"` as text about markup; both sides are scanned
// the same way, so such a fragment is compared consistently and a rewrite of it is reported
// as an alt change, which is the wrong bucket but not a wrong answer about whether the page
// moved.
function altValues(html: string): string[] {
  const values: string[] = [];
  for (const m of html.matchAll(/(?<![-\w])alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    values.push(decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").replace(/\s+/g, " ").trim());
  }
  return values;
}

function altText(html: string): string {
  return altValues(html).join("\u0000");
}

// Where one enumeration inside a description ends and the next begins. A member list is written with
// commas, and what separates two such lists is heavier punctuation: "the darkest states are Ohio,
// Wisconsin and Wyoming; cross-hatched are Iowa, Kansas and Missouri".
//
// The period is admitted only after a lowercase letter or a closing quote or bracket, which keeps
// this off the two shapes that carry one INSIDE a member: an abbreviation ("MO.", "N.D.", "D.C.")
// and a decimal ("the 1.5 thru 1.9 category"). Both are ordinary on the maps this reads, and
// splitting either mid-member would cut a bucket in half and report every member on the far side of
// the cut as having moved. Erring this way costs recall instead — two lists written as two sentences
// with no semicolon between them read as ONE bucket here, and a member crossing between them is not
// seen — and that is the right side to err on for a signal with no ground truth to check it against.
const ENUMERATION_BREAK = /(?<=[a-z)"'\]])\.(?=\s|$)|[;:]/;

// The longest a member of an enumeration gets. Members are names — "Missouri", "New Hampshire",
// "District of Columbia" — while the prose that introduces them is not, and prose broken by commas
// is otherwise indistinguishable from a list of two. Without a bound, "which appears cross-hatched
// on the map, placing it in the second band" is two members, and a rewording of that clause reads as
// two relocations. Nothing about a name needs 40 characters.
const MEMBER_MAX = 40;

// The fewest names a comma-separated run must hold to be read as a list at all.
const LIST_MIN = 2;

// One description's enumerations: the member sets of each comma-separated list in it, and where in
// them each member sits.
//
// Keyed on a normalised form, so a member re-typed in another case or with its spacing changed is
// the same member — the question here is whether a member MOVED, and one that merely gained a
// capital letter has not. A member occurring more than once is dropped outright rather than resolved
// to one of its occurrences: which of two "Missouri"s the one in the corrected reply corresponds to
// is exactly what this cannot know, and settling it by position would be a guess reported as a
// measurement.
function enumerationsIn(alt: string): {
  buckets: Set<string>[];
  memberOf: Map<string, { shown: string; bucket: number }>;
} {
  const buckets: Set<string>[] = [];
  const memberOf = new Map<string, { shown: string; bucket: number }>();
  const dropped = new Set<string>();
  for (const bucket of alt.split(ENUMERATION_BREAK)) {
    const members: { key: string; shown: string }[] = [];
    const pieces = (bucket ?? "").split(",");
    for (const [at, piece] of pieces.entries()) {
      // Where a conjunction separates two members and where it is inside one name, decided by what the
      // bucket uses as its separator elsewhere. "and" and "or" sit inside plenty of names — "Trinidad
      // and Tobago", "Bosnia and Herzegovina", "Antigua and Barbuda", "Health and Human Services" —
      // and a name split down its own conjunction becomes two phantom members that always travel
      // together, so the halves share company in both replies, the disjointness test below can never
      // hold, and the member is unreportable however far it moves (#358 review, twice).
      //
      // A bucket written WITH commas has told you what its separator is, and a conjunction there does
      // one job: it joins the last member. So only the last piece is opened, and only on the FIRST
      // conjunction in it — "Suriname and Trinidad and Tobago" separates into the member and the name
      // rather than into the name's halves.
      //
      // A bucket written with NO commas has no other separator to go on, and the conjunction is doing
      // the work all of them would have done: "Ohio and Wisconsin and Wyoming" is three members, and
      // reading it as two puts a name nobody wrote — "Wisconsin and Wyoming" — where a key should be,
      // which loses the real member silently. So every conjunction opens there.
      //
      // Opening every conjunction of a comma-less run also lets a word that is not a NAME onto the
      // line, which is the price of reading a run-on at all: "the legend runs pale and light and medium
      // and dark" separates into band words, and a correction that moves one of them across a semicolon
      // is a token that changed bucket exactly as this field says. So an entry here is a token and not
      // necessarily a place, and that is said wherever these limits are — a corpus counted off this
      // line needs to know that some of its members are adjectives.
      //
      // One genuinely ambiguous position is left rather than guessed at: a conjunction name as the
      // FIRST half of the last piece of a comma'd list — "Darkest: Ohio, Health and Human Services and
      // Education" — reads as three members, because nothing in the string says which "and" is the
      // list's. Wherever these limits are stated, that shape is stated as a silent miss.
      const commaless = pieces.length === 1;
      const last = at === pieces.length - 1;
      const split = commaless
        ? piece.split(/\s+(?:and|or)\s+/i)
        : last
          ? (piece.match(/^(.*?)\s+(?:and|or)\s+(.*)$/i) ?? []).slice(1)
          : [];
      for (const item of split.length ? split : [piece]) {
        const shown = item.replace(/^(?:&|and|or)\s+/i, "").replace(/\s+/g, " ").trim();
        if (!shown || shown.length > MEMBER_MAX) continue;
        // A trailing period is not part of the name, and whether a member keeps one depends on where
        // in its list it fell rather than on anything about the member: "Wyo." at the end of a
        // description loses its dot to the sentence break above, and the same abbreviation before a
        // comma keeps it. Left in the key, `Wyo` and `Wyo.` are two members and a move between the
        // two lists would be invisible — which is precisely the shape of description this reads.
        members.push({ key: shown.toLowerCase().replace(/\.+$/, ""), shown });
      }
    }
    // One name is not a list, and two is the whole floor here: what keeps this off reworded prose is
    // `DESTINATION_OVERLAP` below, which in demanding two names that were already listed together puts
    // the list a member JOINS at three however low this sits. Both directions are pinned, because a
    // first draft demanded three at each end and nothing in the tests objected — it was a second guard
    // on a shape the destination clause already refuses, and it silently declined #355's own shape at
    // its smallest, a two-name band losing a member into a band that already existed. Below two, a
    // lone name in a clause reads as a category of one, and a member that was listed with nobody has
    // no first company for this to compare its second against.
    if (members.length < LIST_MIN) continue;
    const index = buckets.length;
    buckets.push(new Set(members.map((m) => m.key)));
    for (const m of members) {
      if (memberOf.has(m.key) || dropped.has(m.key)) {
        memberOf.delete(m.key);
        dropped.add(m.key);
        continue;
      }
      memberOf.set(m.key, { shown: m.shown, bucket: index });
    }
  }
  return { buckets, memberOf };
}

// How many of a member's new neighbours have to have been listed together BEFORE for the list it
// joined to count as one that already existed. Two: one shared name is a coincidence between any two
// pieces of prose about the same picture, and this is the clause that separates "moved from one list
// into another" from "the sentence around it was rewritten".
const DESTINATION_OVERLAP = 2;

const without = (set: Set<string>, key: string): Set<string> =>
  new Set([...set].filter((k) => k !== key));

const shared = (a: Set<string>, b: Set<string>): number => [...a].filter((k) => b.has(k)).length;

// The most one correction reports, so that a wholesale rewrite of a description cannot put a hundred
// names on a log line. A relocation is a shape to go and look at, and the first few names are enough
// to find the page.
const RELOCATED_MAX = 6;

// Members a correction moved from one enumeration into a DISJOINT one: listed with one set of names
// before, and after with a set sharing none of them. Both replies put the member in some category
// and they named different categories, which where the categories are mutually exclusive means the
// correction asserts of that member exactly what the reply it corrected denied.
//
// #355 is the case. On a shaded map of state property tax rates the verify pass made ONE edit to the
// description's bands, and it moved Missouri out of "darkest" into "cross-hatched". Measuring the
// plate put Missouri on the flat side of the legend's own dispersion gap by 1.9×, and 2.8× below a
// confirmed cross-hatched state at the identical level on the same plate — so $0.045 converted a
// classification the image permits into the one it excludes. Nothing recorded that a member had
// crossed: both replies existed, one after the other, and no code compared them.
//
// This reports the shape and takes no view on which reply is right. It cannot have one — on that
// plate the two dark categories are 13 units apart under a 112-unit lighting gradient, so the level
// axis refuses the question outright — and a guard that REFUSED such a correction would as often be
// refusing the fix. What it hands a reader of the log is the name to go and check, which is why the
// members are named rather than counted: a boolean saying something moved somewhere is not a claim
// anybody can verify afterwards.
//
// Reordering is not relocation, and the disjointness is what says so: a pass that rewrites "Ohio,
// Wisconsin, Wyoming" as "Wisconsin, Ohio, Wyoming" leaves every member listed with the same
// company, so the two sets intersect. A member the correction ADDED or DROPPED is likewise not
// reported — it has no pair of lists to compare, and the sizes already on the effect are what say
// whether a description gained or lost content.
//
// Two conditions past being a list at all, and the second is the one that makes this quiet enough to
// read. The two lists must share no member, or the member did not leave; and the list it joined must
// be one that ALREADY EXISTED in the description it corrected (`DESTINATION_OVERLAP`) — a member
// whose new neighbours are all new text is a member whose sentence was rewritten around it, which is
// the commonest thing a correction does and nothing at all like a reclassification. Neither end needs
// a size check of its own: `LIST_MIN` leaves the source with a sibling and the overlap leaves the
// destination with two.
export function altRelocations(before: string, after: string): string[] {
  const from = altValues(before);
  const to = altValues(after);
  // Descriptions are paired by position, so a correction that added or removed an image has shifted
  // every pairing after it and this can say nothing: comparing one image's alt against its
  // neighbour's would report every member of both as relocated. A correction that changes how many
  // images there are is a change `structure_changed` already names.
  if (from.length !== to.length) return [];
  const moved: string[] = [];
  for (const [i, alt] of from.entries()) {
    const wasIn = enumerationsIn(alt);
    const nowIn = enumerationsIn(to[i]);
    for (const [key, was] of wasIn.memberOf) {
      const now = nowIn.memberOf.get(key);
      if (!now) continue;
      const left = without(wasIn.buckets[was.bucket], key);
      const joined = without(nowIn.buckets[now.bucket], key);
      if (shared(left, joined) > 0) continue;
      const existed = wasIn.buckets.some(
        (b, at) => at !== was.bucket && shared(without(b, key), joined) >= DESTINATION_OVERLAP,
      );
      if (!existed) continue;
      moved.push(was.shown);
      if (moved.length === RELOCATED_MAX) return moved;
    }
  }
  return moved;
}

// A figure's caption read as a claim about the same picture its description describes.
//
// The `<figcaption>` is the typesetter's own sentence and the `alt` is the model's, and they arrive
// in one fragment with no image between them, which makes the comparison the one check on a
// description that costs no call, no pixel and no word list (#356). Two of its three axes are
// already rules in both prompts: a count the page PRINTS against the length of the list (v1.11), and
// a region the page names as highest or lowest against the bands the description sorts places into
// (v1.12). What is here is not a third rule. It is the RECORD that those two leave nothing of when
// they decline, plus the subject list for the axis that cannot be built yet.
//
// The decline is the whole reason this is code rather than more prose. v1.12's clause ends by
// refusing the comparison where the caption's named group is not one the page itself sorts —
// supplying "which states are New England" from a model's own knowledge is how that check invents
// the problem it then reports — so a round that reports no region contradiction is either a round
// with none or a round where every subject was refused, and from outside those are the same silence.
// Over 1,302 delivered pages of the rounds on disk this fires on 66 figures across four plates, and
// 47 of the 50 region claims among them are subjects the clause must decline: 44 where the caption's
// group is nowhere in the description's own bands, and 3 more where the description sorts nothing at
// all. The 3 that are decidable are all one arm describing the map BY region, which is the shape
// that puts the membership on the page.
//
// Nothing here refuses, corrects or reaches a verdict, and no field is a proportion. That is the
// finding rather than a limitation: see `FRACTION_WORDS`.
export type CaptionClaim = {
  figure: number;
  caption: string;
  quantifier?: string;
  share?: number;
  band?: string;
  enumerations: number;
  named?: string[];
  declined?: string[];
};

// A figure and its caption. Both close at the first end tag or at the end of the fragment, because
// this reads model output mid-pipeline for the reason the whole module does: a page cut off inside
// its last figure still has a caption to compare, and a scan that required the close tag would drop
// exactly the page most likely to have lost something.
//
// A figure ALSO closes at the next one's open tag, and that is not tidiness. With only the two ends
// above, a reply that dropped one `</figure>` mid-fragment let the first figure swallow the second:
// `altValues` then harvested both descriptions, and the caption was matched against the members of a
// picture it does not caption — which is what the scoping below exists to prevent. It fails in the
// one direction this record cannot afford, turning a declined check into an apparent decidable one
// by supplying the membership out of a neighbouring figure, so the page's own markup does what the
// v1.12 clause refuses to do from a model's knowledge.
const FIGURE = /<figure\b[^>]*>([\s\S]*?)(?:<\/figure>|(?=<figure\b)|$)/gi;
const FIGCAPTION = /<figcaption\b[^>]*>([\s\S]*?)(?:<\/figcaption>|$)/i;

// The words a caption quantifies a category with that name a definite fraction, and only those. A
// hedge in front of one does not change the fraction the sentence names, so it is kept in what gets
// recorded — "About Half" is the string the page printed — and the value is read off the noun.
//
// "Most", "a majority", "many", "few", "nearly all" are deliberately absent: each names an
// inequality rather than a value, and a report that turned one into a number would be inventing the
// number it then compared. A printed integer is absent for the opposite reason — that is v1.11's
// axis and it is a rule in both prompts already.
//
// **No proportion is computed from these, and that is a measured decision rather than a gap.** The
// caption states a fraction of a population; the description's categories are the only denominator
// available; and both terms of that ratio are readings of the ink rather than transcriptions of the
// page, so the comparison inherits every bit of the reading's noise. `p092` is the corpus's only
// subject and its five reads put the quantified category at 34.7%, 35.6%, 41.7%, 41.9% and 50.0% of
// the states enumerated, so no tolerance separates a miss from an exact hit on the one plate any
// tolerance could be fitted to (#356 §2). The member parse settles it independently: run over the
// same alt on 16 reads it answers 1, 2 or 3 categories for one unchanged legend, and on the read
// that yields "30 and 16" two of those 46 members are fragments of prose and one state's name was
// lost to a length bound. A share off that is right by cancellation and not by measurement. So the
// subject is recorded — the words, the fraction they name, how many lists the description holds —
// and the arithmetic is left to whoever regrades the log, at whatever tolerance a later corpus can
// justify.
const FRACTION_WORDS: [RegExp, number][] = [
  [/(?:\b(?:about|approximately|around|nearly|roughly|some)\s+)?\bone[-\s]?half\b(?!-)/i, 1 / 2],
  [/(?:\b(?:about|approximately|around|nearly|roughly|some)\s+)?\bhalf\b(?!-)/i, 1 / 2],
  [/(?:\b(?:about|approximately|around|nearly|roughly|some)\s+)?\b(?:a|one)[-\s]third\b/i, 1 / 3],
  [/(?:\b(?:about|approximately|around|nearly|roughly|some)\s+)?\btwo[-\s]thirds\b/i, 2 / 3],
  [/(?:\b(?:about|approximately|around|nearly|roughly|some)\s+)?\b(?:a|one)[-\s]quarter\b/i, 1 / 4],
  [/(?:\b(?:about|approximately|around|nearly|roughly|some)\s+)?\bthree[-\s]quarters\b/i, 3 / 4],
  [/(?:\b(?:about|approximately|around|nearly|roughly|some)\s+)?\b(?:a|one)[-\s]fifth\b/i, 1 / 5],
];

// A caption saying that a group of places runs high or low: the band word has to be what a verb
// asserts of something, not merely present.
//
// The verb is what keeps this off a figure's own title, and the two are not distinguishable any
// other way. `p071` prints "Figure 3. States With Lowest Capacity" above "the Southeastern States
// Rank Lowest", and `p073` prints "Figure 5. States With Highest Capacity" above "Farming and
// Mineral States in the West Rank High": the titles name the band the whole plate is about, which is
// no claim about any group, while the sentences under them are exactly v1.12's subject. Keyed on the
// band word alone, both plates fired on their titles — and on `p073` that read the right page for
// the wrong reason, which is a decline counted where no check was ever available.
//
// Two patterns rather than one verb list, because bare "high" and "low" are only a band where a
// RANKING verb puts them on a scale. "Rank High" is how this document's captions write a superlative,
// so those two words have to be admitted somewhere; admitted after a copula as well they take
// ordinary prose with them — "Unemployment Is High Throughout", "Tax Yields Have Low Variance" —
// neither of which claims anything about a group, and each of which would then write the very line
// this exists to avoid: a decline counted where no check was ever available.
//
// What still fires that is not a claim about a group, stated because these comments are read as the
// account of what the census counted: a title that asserts its band with a verb rather than a
// preposition. "Figure 7. Where Tax Effort Is Highest" is one, and it is a `membership` decline in
// the record. The `States With Lowest Capacity` form above is out, the copula form is in, and no
// wording separates the second from `p095`'s own "The South … Has the Lowest Effective Rates" —
// which is the claim this check is for. So the trade is deliberate and in this direction: a title
// counted as a declined subject over-reports how often the clause had a page to refuse on, while
// dropping the copula would lose the plate the amendment was written about.
const BAND_RANKED =
  /\b(?:rank|ranks|ranked)\s+(?:the\s+|among\s+the\s+)?(highest|lowest|greatest|smallest|largest|high|low)\b/i;
const BAND_ASSERTED =
  /\b(?:is|are|was|were|has|have|had|shows?|stands?)\s+(?:the\s+|among\s+the\s+)?(highest|lowest|greatest|smallest|largest)\b/i;

// A member of the description's own lists that could be the group a caption names: it begins with a
// capital. The false positives to keep out are band labels, which these plates print inside the
// caption as a legend and their descriptions repeat inline — running this over the corpus produced
// "1 thru 1.4", "2.0" and "over", and one test drops all three, because a label is either numeric or
// a lowercase preposition where a place or a region is a proper noun. "New England" and "States in
// the West" survive as the only three decidable subjects the corpus has.
//
// A second test, for a digit anywhere in the member, was here and is gone: over the same 1,302 pages
// it changed no figure's record, and the shape it would have guarded — a capitalised label carrying a
// number, matched against a caption that prints it in the same case — has no instance in them. If one
// ever occurs it reads as one decidable line where a decline belonged, on a record nothing consumes.
const GROUP_NAME = /^[A-Z]/;

// How much of the caption is recorded, and how many named groups. The caption is quoted rather than
// counted because it is the page's own words and the whole point is that a reader can check the
// claim afterwards; a `<figcaption>` on these plates runs to a legend and three sentences, and the
// claim is always in the first of them.
const CAPTION_MAX = 200;
const NAMED_MAX = 6;

const escapeLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One record per figure whose caption makes a claim of the kind those two rules are about. A figure
// with no caption, or a caption with no such claim, produces nothing — which keeps this at 3 or 4
// lines per 91-page arm rather than one per figure, and means a line's presence is itself the fact
// that a free check had a subject here.
//
// Scoped to a `<figure>` that holds both strings, so a caption is compared with the description of
// the picture it captions and not with a neighbouring one. What that leaves out is stated: a claim
// in a `<p>` beside the figure, or in a `<table><caption>`, is v1.12's subject too — the prompts say
// "a `<figcaption>` or a sentence in the fragment" — and this reads only the caption, so a decline
// it does not count is a decline that happened somewhere this cannot see.
export function captionClaims(html: string): CaptionClaim[] {
  const claims: CaptionClaim[] = [];
  for (const [at, figure] of [...html.matchAll(FIGURE)].entries()) {
    const captionMarkup = FIGCAPTION.exec(figure[1]);
    if (!captionMarkup) continue;
    const alts = altValues(figure[1]).filter((a) => a !== "");
    if (alts.length === 0) continue;
    const caption = visibleText(captionMarkup[1]);
    let quantifier: string | undefined;
    let share: number | undefined;
    for (const [pattern, value] of FRACTION_WORDS) {
      const found = pattern.exec(caption);
      if (found) {
        quantifier = found[0].trim();
        share = value;
        break;
      }
    }
    const band = (BAND_RANKED.exec(caption) ?? BAND_ASSERTED.exec(caption))?.[1].toLowerCase();
    if (!quantifier && !band) continue;
    // Joined on a semicolon, which is one of `ENUMERATION_BREAK`'s own separators: two images in one
    // figure are two descriptions, and a join that let the first one's last list run into the
    // second's first would read a member as sharing a category with places it was never listed with.
    const { buckets, memberOf } = enumerationsIn(alts.join("; "));
    // Bounded on both sides by something that is not part of a word, so a caption's "New Englanders"
    // is not the region "New England"; and case-sensitive, which over the same 1,302 pages changes
    // exactly one figure's answer and changes it from wrong to right. `p071`'s description labels the
    // map with postal abbreviations, which makes "OR" a member, and its caption says "Per Capita
    // Income or Per Capita Yield": ignoring case reports a named group, and so a decidable check, on
    // the one plate whose claim is about "the Southeastern States" — a region the page never sorts.
    // What case-sensitivity costs is a group the caption re-typed in another case, which goes
    // uncounted and so reads as declined: the conservative direction for a field whose whole job is
    // to say the check had nothing to work with.
    const named: string[] = [];
    for (const member of memberOf.values()) {
      if (!GROUP_NAME.test(member.shown)) continue;
      if (new RegExp(`(?<![\\w.])${escapeLiteral(member.shown)}(?![\\w])`).test(caption)) {
        named.push(member.shown);
        if (named.length === NAMED_MAX) break;
      }
    }
    // Why nothing was compared, and each reason belongs to one of the three axes. `proportion` is
    // unconditional wherever a caption quantifies in words, because that axis declines by design
    // (see `FRACTION_WORDS`) — a constant on a line that only exists because the subject is there,
    // and the alternative is a log that says nothing at all about the axis #356 asked for.
    // `no_enumeration` is a description that sorts nothing into anything: both remaining checks need
    // a list, and the arm this fires on is the cheapest one in every round measured, which is worth
    // knowing before either rule is priced — an arm that makes no checkable claim escapes a check
    // rather than passing it. It also settles the membership question by pre-empting it, which is
    // why the two are exclusive rather than joined: where there are no bands, there is no band for a
    // region's members to be missing from.
    const declined: string[] = [];
    if (quantifier) declined.push("proportion");
    if (buckets.length === 0) declined.push("no_enumeration");
    else if (band && named.length === 0) declined.push("membership");
    claims.push({
      figure: at + 1,
      caption: caption.slice(0, CAPTION_MAX),
      ...(quantifier === undefined ? {} : { quantifier, share }),
      ...(band === undefined ? {} : { band }),
      enumerations: buckets.length,
      ...(named.length === 0 ? {} : { named }),
      ...(declined.length === 0 ? {} : { declined }),
    });
  }
  return claims;
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
  // Which members a description now lists in a different category than it did — see
  // `altRelocations`. Absent where none did, which is the ordinary case, so this adds nothing to
  // the line for a correction that did not reshuffle a list; present with the names, because the
  // names are the whole use of it. Not one of the four ways above and not a fifth: a relocation
  // always shows up as `alt_changed` too, and what it adds is what KIND of alt change it was.
  alt_relocated?: string[];
}

export function correctionEffect(before: string, after: string): CorrectionEffect {
  // Held rather than recomputed inside the comparison: the same two strings answer both
  // `text_changed` and the sizes, and a second pass over a 20 kB fragment to ask a second
  // question about it is work for nothing.
  const textBefore = visibleText(before);
  const textAfter = visibleText(after);
  const relocated = altRelocations(before, after);
  return {
    chars_before: before.length,
    chars_after: after.length,
    text_chars_before: textBefore.length,
    text_chars_after: textAfter.length,
    text_changed: textBefore !== textAfter,
    alt_changed: altText(before) !== altText(after),
    attrs_changed: attrText(before) !== attrText(after),
    structure_changed: tagShape(before) !== tagShape(after),
    ...(relocated.length ? { alt_relocated: relocated } : {}),
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

// The same question about a review round's BODY, which is a different distribution and so a
// different number, read on a different quantity (#174). Two constants rather than one because
// #174 said so in as many words — "not this floor's number" — and the measurement below is why.
//
// A HALF, not a quarter, because the two populations are further apart here than they are on the
// page path and the cost of getting it wrong is asymmetric. Every legitimate round that records
// both sizes lands within 0.6% of the body it was given: 0.997 on the one answered whole, and
// 0.998 / 1.006 / 1.001 on the three answered section by section (`runs-231`, four documents, the
// first bench round carrying these numbers). The three earlier samples are 1.000 by construction —
// a reply with nothing usable in it is a body handed back untouched — so they bound nothing, and
// this is a band read off four rounds, which is why it is set so far from all of them. What it is
// set BELOW is the failure it exists to catch: a reply that returns one part of the document
// instead of the document, and a section of one of these bodies is 0.016–0.379 of it. Half sits
// clear of both ends.
//
// The asymmetry: refusing a legitimate round costs that round's corrections, and the document is
// delivered with those issues marked @unresolved — a state this loop already supports and reports.
// Accepting a reply that is not the document costs the document. So the floor belongs as high as
// the legitimate distribution safely allows, which is the opposite of how the page floor was
// placed (there, a refused correction ships a page nobody checked again).
//
// On the VISIBLE TEXT, and this is the substantive finding rather than a detail. Neither of the
// other two readings on the `editor` line can carry a floor:
//
//   - Raw characters cannot, because unwrapping a mis-structured document is the editor doing its
//     job and it is mostly bytes. `<section><div><h2>x</h2><div><p>y</p></div></div></section>`
//     unwrapped keeps every word and loses 53% of the characters (the case pinned in
//     test/editor-round-size.test.ts), and #174's own examples of legitimate deletion — "an
//     unwarranted `<section>` wrapper" — are exactly that shape. A raw floor at a half would refuse
//     it; one loose enough not to would be past the fragment it needs to catch.
//   - The structure counts cannot, and this is the reading #174 guessed would be the better one.
//     The measured whole-body round rewrote a 55-item `<dl>` into list items: `terms` 55 -> 3, a
//     ratio of 0.055, while its prose moved 0.3% and every word survived. A structure floor loose
//     enough to allow that round is loose enough to allow anything, and one tight enough to be
//     worth having would have thrown away a correct rewrite of the whole document.
//
// Both stay on the `editor` line as measurements. What sees a markup-only loss is the structure
// pair plus the re-lint of the body that ships; what sees content leaving is this.
//
// The known cost, named because it is the one legitimate round that can approach a half on the
// prose: EDITOR_SYSTEM sanctions one deletion that scales with the document — "remove duplicated or
// redundant content (e.g. the same content rendered as both a form and a table — keep the best
// single representation)". On a scanned form whose extraction emitted both, dropping the table drops
// the copy carrying MORE prose, because a table repeats its labels once per row. A body that is
// mostly such a pair therefore lands near or under 0.5 and is refused, and the refusal is not
// confined to that fix: the round is `usable: false`, so every other correction in the same reply
// goes with it, and the next round asks the same thing of the same body and is refused again to the
// cap, so those issues ship @unresolved. That is the trade taken knowingly — the alternative is a
// floor that also admits a reply carrying one section of the document — and it is reported rather
// than silent: `editor_shrank` carries both prose sizes, so a round refused for a deletion that was
// the point of it is visible in the log, which is where the evidence for anything cleverer (a floor
// that reads the duplicated representation's own size) would have to come from. No round in
// `runs-231` is this shape; the four measured are all within 0.6%.
export const EDITOR_SHRINK_FLOOR = 2;

// How much prose a body needs before a PROPORTION of it is a measurement at all, in visible
// characters. Under this, nothing is refused.
//
// Not an escape hatch — the arithmetic of the floor above stops working at the bottom of the range.
// The legitimate deletions #174 lists are fixed-size rather than proportional (the one sanctioned
// deletion that is not is named above, and it is the floor's known cost, not this bound's): `[page
// not fully transcribed]` is 28 characters, a duplicated heading is 20–60, a transcribed page
// number is one to three. Ten of those is 300 characters however long the document is, so on a body
// of 500 the floor is reachable by the editor doing exactly what it was asked, and on a body of
// 50 — which is what several of this repo's own round fixtures are — a single resolved marker trips
// it. A thousand puts the smallest firing at 500 characters of prose gone, which is not a count of
// headings and page numbers, it is paragraphs.
//
// What it gives up is the floor on a document with under about 150 words in it, and that is the
// cheap end of the trade in both directions: the ratio there is noise, and the thing being
// protected is a document a reader loses a paragraph of. The expensive case — a 25-page report
// whose body comes back as one section — is nowhere near it: the four measured bodies carry
// 43,969 to 72,197 characters of prose, so 44 to 72 times over this line. Sections are
// judged by the same number and a section of pure markup can fall under it; same reasoning, and
// bounded to that section rather than to the document (`joinSections` keeps the text that went in).
//
// The precedent for a lower bound on proportional machinery is `MIN_SECTION_BUDGET`, which declines
// for the same kind of reason rather than guessing at a size the arithmetic cannot carry.
export const EDITOR_FLOOR_MIN_TEXT = 1_000;

// Did the round lose the body rather than correct it? Used on the whole body and on one section,
// which are the same question about different amounts of document.
export function destroyedBody(before: string, after: string): boolean {
  const text = visibleText(before).length;
  if (text < EDITOR_FLOOR_MIN_TEXT) return false;
  return visibleText(after).length * EDITOR_SHRINK_FLOOR < text;
}

// How many measurement-only re-verifications a batch of pages may buy, and which pages
// get them.
//
// The count is `defaults.recheck_sample_size` (config.ts, default 1) — a deployment
// knob rather than a constant here, because the number that reads it is a rate and one
// draw per run cannot produce one. See `DEFAULT_RECHECK_SAMPLE_SIZE` for the cost of a
// census and for what it took to answer the question without one (issue #288).
//
// `left` was the whole of this: the first corrected page to ARRIVE took the slot. That
// is a defect in what the sample means, separate from its size, and the reason it is not
// self-correcting: pages are corrected concurrently up to `extraction_concurrency`, so
// the winner is drawn from the batch's opening pages, and on `runs-extract100-1` all 8
// slots across 8 batches landed on exactly that (p001, p027, p028, p051, p076, p077).
// Accumulating such draws over a week of runs does not widen the population — it asks
// about page 1 of every document, repeatedly.
//
// A slot is therefore claimable only from a page whose order has reached that slot's
// THRESHOLD, and the thresholds are spread across the run: for k slots over N pages, the
// pages nearest 1/2k, 3/2k, 5/2k ... of the way through. One slot lands mid-batch — page 13
// of 25, page 50 of 100 — two on the quarters, and k >= N puts a threshold on every page: a
// census, the only setting with no selection left in it. On a batch of two pages there is no
// room to spread and the first page is the threshold, which is the old behaviour and the
// right one there. The claim on this is narrow and worth stating as such:
// which page a fixed threshold picks still depends on the document, so this is not a
// random draw and it is not evidence that any position is representative. What it does is
// make the sampled position depend on the document's length and on which of its pages
// needed correcting, so a fleet of runs samples more than one page. Deterministic on
// purpose, too: a measurement whose corpus can be replayed off persisted replies is worth
// more than an unbiased draw of one page in twenty-five.
//
// A run whose corrections all fall before its lowest threshold takes no sample. That is
// the honest outcome and it is the cost of the change: the old rule always spent its slot,
// on the page it always spent it on.
//
// The links path re-verifies for its own reasons on every page it applies to, and that
// verdict is logged the same way but counted apart (`rechecks.binding`), so none of the
// above applies to it.
export interface RecheckSampler {
  // Ascending page orders, each a band worth one re-verification to a corrected page that
  // has reached it — the highest such band, so out-of-order arrival cannot spend a low one
  // (`claimRecheck`). Consumed as they are claimed, so its length is the sample still
  // unspent and `[]` is a sampler with nothing left (or one that was never given anything,
  // at `recheck_sample_size: 0`).
  thresholds: number[];
}

// `pageOrders` is the orders of the pages THIS batch will run, not a count of them: a
// feedback round re-extracts a few pages of a long document (pages 7, 12 and 20 of 25),
// and a band expressed as a fraction of a page count would put every threshold below the
// first of them and hand the slot straight back to whichever arrived first.
export function recheckSampler(pageOrders: number[], size: number): RecheckSampler {
  const orders = [...pageOrders].sort((a, b) => a - b);
  const n = orders.length;
  const k = Math.min(Math.max(0, Math.floor(size) || 0), n);
  // The page nearest the midpoint of each of k equal bands OF THE BATCH, taking the lower
  // page when the midpoint falls between two. Strictly increasing, and there are exactly k
  // of them, with no de-duplication needed: consecutive midpoints are n/k pages apart and
  // k <= n, so no two can round to the same page (asserted over every n and k up to 200 in
  // test/recheck-sample.test.ts). Two thresholds on one page would let that page take two
  // slots and report two draws from one measurement.
  const thresholds: number[] = [];
  for (let i = 0; i < k; i += 1) {
    thresholds.push(orders[Math.min(n - 1, Math.max(0, Math.round(((i + 0.5) * n) / k) - 1))]);
  }
  return { thresholds };
}

// Take a sample slot for a page, if that page's order has reached any threshold still
// unspent. Claimed SYNCHRONOUSLY and before the call it authorizes, because pages are
// extracted concurrently: a check that awaited first would let several pages each see a
// free slot and every corrected page would be re-verified, which is the cost this bounds.
//
// A page past several unspent thresholds takes ONE of them — the sample is a page count,
// so a page cannot be worth two of it — and it takes the HIGHEST one it has reached,
// leaving the lower bands for pages that have not arrived yet. That direction is the whole
// of the arithmetic here, and it is the one that survives out-of-order arrival, which is
// the condition this sampler exists because of: any page that can reach a high threshold
// can reach every lower one too, so the low bands are the flexible resource and spending
// them first strands the sample. At `recheck_sample_size: 3` on a 3-page document with all
// three corrected (thresholds [1, 2, 3]) whose corrections land in the order 3, 2, 1,
// consuming the lowest gives page 3 the band at 1 and page 2 the band at 2 and then
// refuses page 1 — two draws out of three, from a setting documented as a census, and the
// log cannot say it was short. Taking the highest gives each page its own band whatever
// order they arrive in.
export function claimRecheck(sampler: RecheckSampler, order: number): boolean {
  // Ascending, so the last threshold at or below this page's order is the highest it has
  // reached; -1 means the page has not reached any of the ones still unspent.
  let claim = -1;
  for (let i = 0; i < sampler.thresholds.length; i += 1) {
    if (sampler.thresholds[i] > order) break;
    claim = i;
  }
  if (claim < 0) return false;
  sampler.thresholds.splice(claim, 1);
  return true;
}
