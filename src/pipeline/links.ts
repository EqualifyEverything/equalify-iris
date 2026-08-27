import { MAX_LINKS_PER_PAGE, type PdfLink } from "../util/pdf.ts";
import { decodeEntities } from "../util/html.ts";

// Carrying a PDF's links into the delivered HTML.
//
// A link in a PDF is an annotation — a rectangle plus a URI — laid over the page,
// not something drawn on it. Rasterizing the page for the vision model therefore
// throws every link target away: "read the full report" arrives as three words that
// happen to be blue, and the model has nothing to make an <a href> out of. The
// result was a document where the text survived and every link in it was gone, which
// for a screen-reader user is worse than it sounds: the destination is not merely
// hidden, there is no indication a destination existed.
//
// So the targets are extracted from the file directly (util/pdf.ts) and handed to the
// page agent alongside the image, as ground truth it cannot see. Attaching them is
// left to the model rather than done by string substitution on its output, because
// deciding WHICH text an annotation's rectangle covers, in the structure the model
// chose to emit, is the same judgement the extraction itself is: the anchor text is
// approximate (poppler's text layer, split at line breaks), and a search-and-wrap
// over generated HTML would as happily wrap a heading, a table cell, or half an
// attribute value.
//
// What is checked deterministically is whether the links arrived — `missingLinks`
// below — because that has an exact answer, and a link the model dropped is fed back
// to it as a fidelity problem alongside the source image (see extraction.ts).

// A link's URL, reduced to a form two spellings of the same URL agree on. Entities
// are decoded because the model writes `&amp;` into an href where poppler reports
// `&`, and the scheme is lowercased because it is case-insensitive. Nothing else is
// touched: a path, query, or fragment IS case-sensitive, and %-encoding is not
// normalized either, because `%2F` and `/` are genuinely different path segments.
//
// The trailing slash is dropped so `https://example.org/` and `https://example.org`
// are one link. That is a real equivalence for an empty path, and the alternative is
// reporting a link as missing over a character a browser resolves identically.
function normalizeHref(href: string): string {
  return decodeEntities(href)
    .trim()
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:/, (scheme) => scheme.toLowerCase())
    .replace(/\/+$/, "");
}

// Does this href name a scheme? Both comparisons below are about URLs that came from
// (or claim to have come from) the source file's annotations, and only an absolute
// href can be one of those.
function isAbsolute(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

// Every href in a fragment of HTML, normalized. A scan rather than a parse because
// this runs on model output mid-pipeline, where the fragment may not be well-formed
// yet — the same reason anchors.ts keeps a scan alongside its parser. Unquoted
// attribute values are included since a model writes them from time to time.
function hrefsIn(html: string): Set<string> {
  const found = new Set<string>();
  for (const m of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    found.add(normalizeHref(m[1] ?? m[2] ?? m[3] ?? ""));
  }
  return found;
}

// The page's links, as the section of the page-agent prompt that carries them, plus
// what was dropped to bound it. Empty section when the page has no links, so an
// image upload (or a PDF with none) sends exactly the prompt it sent before.
export function pageLinkContext(links: PdfLink[] = []): {
  section: string;
  shown: PdfLink[];
  dropped: number;
} {
  if (links.length === 0) return { section: "", shown: [], dropped: 0 };
  const shown = links.slice(0, MAX_LINKS_PER_PAGE);
  const dropped = links.length - shown.length;
  const list = shown
    .map((l, i) => `${i + 1}. ${l.text ? `"${l.text}"` : "(no text found under the link)"} -> ${l.href}`)
    .join("\n");
  const section =
    `\n\n## Links on this page (from the source file's own link annotations)\n` +
    `The image cannot show where a link points — a PDF link is an annotation over the page, ` +
    `not part of the picture — so the source file's link targets are listed here. The URLs are ` +
    `exact. The anchor text is APPROXIMATE: it comes from a separate text extraction, so it may ` +
    `be split across lines, clipped short, or differ in spacing from what you see.\n\n` +
    `${list}\n\n` +
    (dropped > 0 ? `(…and ${dropped} more link${dropped === 1 ? "" : "s"} on this page.)\n\n` : "") +
    `Wrap the matching visible text in <a href="…"> using each URL EXACTLY as written above — ` +
    `never shorten, re-encode, or guess one. Link the text the page itself presents as the link ` +
    `(a phrase, not the whole paragraph or heading around it), and keep the link INSIDE the ` +
    `structure you would have chosen anyway: a link never changes what an element is, never ` +
    `duplicates content, and never wraps a whole table, list, or section. Do not invent links ` +
    `for anything not listed; the one exception is a URL printed visibly in the text, which may ` +
    `link to itself. If you genuinely cannot tell which text a link belongs to, attach it to the ` +
    `text that plainly matches its purpose and say so in the "log" field rather than dropping it.\n`;
  return { section, shown, dropped };
}

// The links whose URL is nowhere in the produced HTML. Deduplicated by URL: one <a>
// is enough to say the target survived, and a page that repeats a URL under two
// phrases would otherwise report a miss for a link that is present.
export function missingLinks(links: PdfLink[] = [], html: string): PdfLink[] {
  if (links.length === 0) return [];
  const present = hrefsIn(html);
  const seen = new Set<string>();
  const missing: PdfLink[] = [];
  for (const l of links.slice(0, MAX_LINKS_PER_PAGE)) {
    const key = normalizeHref(l.href);
    if (present.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(l);
  }
  return missing;
}

// A dropped link, phrased for the self-correction pass — which sees this text and the
// source image, so it is told where to look, not just what is wrong.
export function missingLinkProblem(link: PdfLink): string {
  const where = link.text ? `the text "${link.text}"` : "text on this page";
  return (
    `The source file has a link on ${where} pointing to ${link.href}, and your output does not ` +
    `link to it. Wrap that text in <a href="${link.href}"> — exactly that URL — without changing ` +
    `anything else about the page.`
  );
}

// Links a rewrite of the document lost: absolute URLs the earlier body linked to and
// the later one does not.
//
// The review loop is where a link is most quietly at risk. The Copy Editor rewrites
// the WHOLE body from the HTML plus the source images — and an href is the one piece
// of content that is not in either the text it is rewriting or the image it is
// checking against, so a link it drops cannot be noticed by the Reader (which never
// sees the source) or recovered from the page (which never showed the URL). It is
// told to preserve them; this reports it when it did not.
//
// Only absolute URLs, deliberately. In-document references churn legitimately —
// anchors.ts renames colliding ids as pages are joined, and the editor renumbers
// footnotes when it fixes their structure — so including them would report ordinary
// work as loss and bury the case that matters.
export function droppedHrefs(before: string, after: string): string[] {
  const kept = hrefsIn(after);
  return [...hrefsIn(before)].filter((h) => isAbsolute(h) && !kept.has(h)).sort();
}

// Every in-document reference in the delivered document, and whether it lands (#234).
//
// This is the question no component asked. `missingLinks` asks whether the source file's
// URLs arrived, `droppedHrefs` asks whether a rewrite lost one, `unexpectedHrefs` asks
// whether one was invented — all three about absolute URLs, and all three deliberately
// silent about `href="#…"`, which anchors.ts owns. anchors.ts, in turn, resolves a
// reference only when at least one page CLAIMS the id: `resolve` returns any other token
// unchanged, so a reference nobody can have meant is neither repointed nor reported
// (`ambiguous: []` on a document whose whole table of contents was dead). Each component
// is right about its own question; the end state — does every reference in the document
// that ships land on an id in that document — belonged to nobody.
//
// Two shapes, counted apart because they have different causes and different remedies:
//
//   `empty`     `href="#"`. A link the agent wrote knowing it had no target, which is
//               what a model produces when it is asked for the shape of a table of
//               contents and the destinations are not on this page. Not recoverable by
//               renaming anything: there is no target to find.
//   `dangling`  a fragment naming an id the document does not contain — a target that
//               moved, was never emitted (a footnote marker whose note the page did not
//               transcribe), or is in a part of the document this run did not have.
//
// Neither is an axe violation, so a document full of them lints clean and reads as
// finished. `#` and `#top` are the two fragments a browser resolves without an element
// (HTML's "top of the document"), so `#top` is not dangling and `#` is reported as its own
// number rather than as a missing id.
//
// Comments are stripped before anything is counted. The delivered document carries the
// @unresolved list and the other markers, which are model-written prose about the
// document and can quote markup — an `<a>` inside a comment is not a link, and counting
// one inflates both the numerator and the denominator.
//
// Every count here is per REFERENCE, so `refs` is the denominator of `empty + dangling`
// and "12 of 226 go nowhere" reads as a maintainer expects. `ids` is the odd one out and
// deliberately so: it is the distinct set, because it goes into a log line capped at 20
// and a table of contents pointing forty times at one missing section would otherwise
// spend the whole cap on a single fact.
//
// Both attribute scans require whitespace or `<` in front of the name, which matters more
// than it looks. `\bid=` matches inside ANOTHER attribute's value — a source PDF whose
// annotation carries `?id=intro` would register `intro` as an id the document contains,
// silencing a genuinely dead `#intro`, and `data-id="s1"` masks `#s1` the same way (`-` is
// a non-word character, so `\b` is satisfied). That failure mode is the worst one
// available here: it hides exactly the defect this function exists to surface.
export function unresolvedRefs(html: string): {
  refs: number;
  empty: number;
  dangling: number;
  ids: string[];
} {
  const text = html.replace(/<!--[\s\S]*?-->/g, " ");
  const ids = new Set<string>();
  for (const m of text.matchAll(/(?<=[\s<])id\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    ids.add(normalizeFragment(m[1] ?? m[2] ?? m[3] ?? ""));
  }
  let refs = 0;
  let empty = 0;
  let dangling = 0;
  const failed = new Set<string>();
  for (const m of text.matchAll(/(?<=[\s<])href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!href.startsWith("#")) continue;
    refs++;
    const token = normalizeFragment(href.slice(1));
    if (token === "") empty++;
    // `top` is matched ASCII case-insensitively by a browser, unlike an id, which is
    // why only this comparison is folded and `ids.has` is left exact.
    else if (token.toLowerCase() !== "top" && !ids.has(token)) {
      dangling++;
      failed.add(token);
    }
  }
  return { refs, empty, dangling, ids: [...failed].sort() };
}

// An id or a fragment, reduced to the form the other spelling of it agrees on. Entities
// because a model writes `&amp;` into an href where the id it means says `&`; percent
// decoding because a fragment is percent-encoded in a URL and an id is not, so
// `href="#f%C3%BC"` and `id="fü"` are the same reference. A malformed escape is left as
// written rather than thrown on: reporting it as dangling on account of a `%` is worse
// than comparing the bytes.
function normalizeFragment(value: string): string {
  const decoded = decodeEntities(value).trim();
  try {
    return decodeURIComponent(decoded);
  } catch {
    return decoded;
  }
}

// Absolute URLs the output links to that no annotation on this page accounts for.
//
// Reported for visibility, NOT corrected, and only for a page that had annotations —
// where there is a ground truth to be outside of. Two innocent things land here: a
// URL printed visibly in the text and linked to itself (which the prompt above
// permits), and a link poppler could not attribute to any text, e.g. one over an
// image. The third is a model that invented a URL, which is the reason this is
// logged at all: it is the failure mode this feature introduces, and without the
// list there is no symptom — a fabricated href looks exactly like a real one in the
// delivered document.
//
// Only hrefs with a scheme are considered. In-document references (`#fn-1`) are the
// page agent's own anchors and anchors.ts owns them; a relative href (`page2.html`)
// is not a URL this page's annotations could have supplied either way, and counting
// one as unaccounted-for dilutes the single signal that is supposed to read as
// "possibly fabricated".
export function unexpectedHrefs(links: PdfLink[] = [], html: string): string[] {
  if (links.length === 0) return [];
  const expected = new Set(links.map((l) => normalizeHref(l.href)));
  return [...hrefsIn(html)].filter((h) => isAbsolute(h) && !expected.has(h)).sort();
}
