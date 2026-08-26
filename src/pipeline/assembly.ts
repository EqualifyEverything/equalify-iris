import { runAxe, lintErrorFields, isKnownLanguage, type LintResult } from "./lint.ts";
import { cutPoints } from "./sections.ts";
import { namespaceAnchors, type AnchorReport } from "./anchors.ts";
import { stripDeprecatedRoles, type RoleStrip } from "./roles.ts";
import type { Fragment } from "./fragment.ts";
import type { PipelineContext } from "./context.ts";

export interface AssemblyResult {
  html: string; // full document (shell + body)
  body: string; // body content only (what the review loop edits)
  lint: LintResult;
}

// Join page fragments in order into clean body content — no provenance comments
// in the delivered HTML. Per-page provenance is preserved in fragments.json.
//
// Ids that more than one page claimed are namespaced as the pages are joined (see
// anchors.ts). This is the only place that can do it: a page is extracted alone and
// concurrently, so it cannot know that another page also numbered its first footnote
// "1", and this is the first moment the whole document exists. The prefix comes from
// `order` rather than the array index so the ids in a delivered document are stable
// across runs and match the page numbering everything else reports (the Reader's
// `pages`, the `assembly_anchors` log, `fragments.json`).
export function assembleBody(fragments: Fragment[]): string {
  return assembleBodyWithReport(fragments).body;
}

// Same join, with what the namespacing did. Split out rather than folded in because
// `assembleBody` has callers that only want the body (the review loop's re-lint, the
// re-extraction baseline) and a returned report they ignore would be one more thing
// to thread through.
//
// A deprecated ARIA role redundant with its host element is dropped here too (roles.ts,
// issue #187) — for the same reason the namespacing happens here and not in a page: it is a
// rewrite with no judgement in it that no model call should be spent on. It is done on the
// joined body rather than per page because there is nothing per-page about it, and a body
// with no such role comes back the same string.
export function assembleBodyWithReport(fragments: Fragment[]): {
  body: string;
  anchors: AnchorReport;
  deprecatedRoles: RoleStrip;
} {
  const ordered = [...fragments].sort((a, b) => a.order - b.order);
  const { pages, report } = namespaceAnchors(ordered.map((f) => ({ order: f.order, innerHtml: f.innerHtml.trim() })));
  const joined = stripDeprecatedRoles(pages.filter((h) => h.length > 0).join("\n\n"));
  return { body: joined.html, anchors: report, deprecatedRoles: joined };
}

// The language the shell declares, read off the body instead of assumed. `lang="en"` on a document
// assembled from Korean pages is not merely unhelpful: WCAG 3.1.1 is about the default human language
// of the page, a screen reader picks its voice from this attribute, and axe cannot see the mistake
// because `html-has-lang` and `html-lang-valid` are both satisfied by a confident wrong answer
// (issue #163). The page agent is told to put `lang` on every top-level element it emits for a page
// wholly in another language (see `agents/page.md`), so the value is here to be read.
//
// It is derived only where the whole body agrees: every top-level element carries a `lang` and they
// all carry the same one. Anything else keeps `en` — a multilingual document has no single primary
// language to declare, and a body whose pages said nothing gives nothing to derive from. The root
// declaration follows the content and never guesses ahead of it, which is why the two halves of #163
// were kept apart: this is only as good as the fragments.
// The start tag opening a top-level segment, anchored: a segment that does not BEGIN with one is not
// an element and is not asked (see below). Group 2 is the attribute list, read attribute by attribute
// rather than searched for ` lang=`, because a search finds one inside another attribute's value —
// `<section title="see lang=fr note">` is a French document by that reading.
const START_TAG = /^\s*<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/;
const ATTRS = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
// A comment, a doctype or a processing instruction: `cutPoints` gives each its own segment, it bears
// no text, and it is what a failed page is in the body as (`@page-failed`).
const OPAQUE_SEGMENT = /^\s*<[!?]/;
function attrValue(attrs: string, name: string): string | null {
  ATTRS.lastIndex = 0;
  for (let m = ATTRS.exec(attrs); m; m = ATTRS.exec(attrs)) {
    // The first spelling wins, which is what a parser does with a repeated attribute.
    if (m[1]!.toLowerCase() === name) return m[2] ?? m[3] ?? m[4] ?? "";
  }
  return null;
}
// The shape of a language tag, not a registry lookup: `lang="Korean"` and `lang="ko_KR"` are the two
// things a model writes when it means `ko`, and either would be a well-formed nothing. The primary
// subtag is held to the two and three letter ISO 639 forms rather than the grammar's 2-8, because that
// is what closes the gap between "shaped like a tag" and "is a language" — `Korean` is a well-formed
// 6-letter subtag and is not a language, while every code a page could honestly be in fits in three.
const LANG_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/i;
// Shape is not enough, because the value goes on the one element in the document that the linter
// checks: an unrecognizable `lang` on the root trades a silent 3.1.1 failure for a loud
// `html-lang-valid` one, which is a regression bought with a fix. Measured with this repo's `runAxe`,
// axe validates against the registry's PREFERRED values, so it refuses exactly the tags that have a
// preferred form — `kor`, `spa`, `fra`, `deu`, `eng`, `zho` and the rest of ISO 639-2/B all fail
// `html-lang-valid`, while `haw`, `chr`, `fil`, `yue`, `ceb` and the other three-letter codes with no
// two-letter equivalent are clean. So the primary subtag cannot simply be narrowed to two letters:
// that would refuse the derivation for every language that only HAS a three-letter code, which is the
// same 3.1.1 defect for a smaller set of readers.
//
// A tag with a preferred form is therefore delivered IN that form rather than refused. `Intl`'s
// canonicalization is the registry's own alias data — `kor` → `ko`, `iw` → `he`, `art-lojban` → `jbo`,
// and `ko` → `ko` untouched — so a page that answered "use the BCP 47 tag" with `kor` still gets a
// Korean root, and it gets the spelling axe and a screen reader both accept. A value the
// canonicalizer refuses outright (`ko_KR`, `ko-x`, `x-klingon`) is not a tag at all and keeps `en`.
// Rewriting a page's answer is worth it only here, at the root: the fragment keeps whatever it wrote,
// where `valid-lang` reports it as a body issue the review loop can correct.
// Tags that are well formed and are not an answer to "what language is this document in": the
// registry's own placeholders for undetermined (`und`), no linguistic content (`zxx`), multiple
// languages (`mul`), uncoded (`mis`) and the private-use range `qaa`–`qtz`. axe accepts every one of
// them, which is precisely why they are refused here rather than left to the gate: as a document's
// DEFAULT HUMAN LANGUAGE they are the same kind of non-answer as `lang="Korean"`, and a screen reader
// given one falls back to its own default anyway. `en` is at least a language a voice can be chosen
// for, and `mul` is the case the unanimity rule already has an answer to.
const NOT_AN_ANSWER = /^(?:und|zxx|mul|mis|q[a-t][a-z])(?:-|$)/i;
// The third question, and the one neither of the two above can answer: is this a language AT ALL.
// Canonicalization is a syntax check plus the registry's ALIAS table, so a subtag with a preferred
// form gets repaired (`kor` → `ko`, which is what the alias table is here for) while one that is in
// no table at all has nothing to look up and passes through untouched onto the root. That is the
// gap #196 measured: `cn`, `jp`, `cz`, `dk`, `gr`, `ua`, `vn` — the country code written where the
// language code belongs, the commonest wrong-but-well-formed `lang` in real HTML and a plausible
// answer to "use the BCP 47 tag" from a model looking at a Chinese page — and `xxy`, `zzz`, shaped
// like a tag and not a language. Each of them put a SERIOUS `html-lang-valid` on the one element
// this file writes: the exact regression the shape check exists to prevent, arriving through the
// part of the question shape cannot answer.
//
// So the question is put to the gate's own list (`isKnownLanguage`, lint.ts) rather than to another
// approximation of it. Three named exceptions had each closed the instances that had been
// demonstrated to them; this closes the class, because "is it a language" is now answered by the
// thing that will be asked.
//
// It is asked about the primary subtag of the CANONICAL value, not the whole tag: `ko-KOREAN` is
// axe-clean and is not a whole tag any list holds. And it does NOT replace NOT_AN_ANSWER — the
// registry lists `und`, `zxx`, `mul`, `mis` and `qaa`–`qtz`, which is precisely why they are refused
// here: they are well-formed, axe is right to accept them, and they are still not a language a
// screen reader can choose a voice for.
function preferredTag(value: string): string | null {
  if (!LANG_TAG.test(value) || NOT_AN_ANSWER.test(value)) return null;
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(value)[0] ?? "";
  } catch {
    return null;
  }
  if (!isKnownLanguage(canonical.split("-")[0] ?? "")) return null;
  if (canonical.toLowerCase() === value.toLowerCase()) return value;
  return LANG_TAG.test(canonical) ? canonical : null;
}
// Elements with no text of their own, which therefore have no language and are not asked for one.
// The page-break separator the page prompt prescribes — `<hr role="doc-pagebreak" aria-label="Page
// 5">` — sits at top level between every pair of pages in a multi-page document, so without this a
// Korean document whose pages all declared `ko` would still be delivered as English: the marker
// carries no `lang`, one disagreement is enough, and the commonest document in the system would
// never derive anything. `aria-label` is not text in the element's language for this purpose
// either; it is generated by the extractor and is English by construction.
//
// The set is these three and not "void elements": a top-level `<img alt="…">` or `<input>` label IS
// text of the page, in the page's language, and a bare one with no `lang` is a page that did not
// answer. That refuses the derivation, which is the safe direction and costs a glance.
const NO_TEXT_OF_ITS_OWN = new Set(["hr", "br", "wbr"]);
// `cutPoints` drops a boundary that lands on the last character, since a cut there would open an
// empty section — so a body that ends properly and a body whose last element was never closed both
// come back with no boundary at the end. The distinction is the whole of the guard below, so the scan
// is run over the body with a comment appended: every real node end is then before the end of the
// string and survives, and the appended comment's own boundary is the one dropped.
const CLOSED = "<!---->";
// Exported for the tests, which read the derivation directly: reaching an interesting case through
// `wrapDocument` means asserting on a whole document shell to learn one attribute.
export function bodyLang(body: string): string | null {
  const boundaries = cutPoints(body + CLOSED).filter((p) => p <= body.length);
  let start = 0;
  let agreed: string | null = null;
  // Anything after the last boundary is a top-level element that was never closed — and an unclosed
  // element swallows everything after it, so the ONE tag this scan would read for that whole run is
  // the first page's. `<section lang="ko"><p>가</p>` followed by three English pages would be read as
  // a Korean document: one page's answer promoted to the root of a document mostly not in it, which
  // is the failure this whole derivation is built to avoid. It is not decidable from here whether the
  // run holds one element or five, so it is refused. The cost is a body whose last element omits its
  // end tag losing the derivation — `en`, a glance, and the fragments keep their own `lang`.
  if (body.slice(boundaries.at(-1) ?? 0).trim() !== "") return null;
  for (const boundary of boundaries) {
    const segment = body.slice(start, boundary);
    start = boundary;
    if (segment.trim() === "" || OPAQUE_SEGMENT.test(segment)) continue;
    // A segment that does not begin with a start tag begins with something else at top level: stray
    // prose between two fragments, or an end tag matching nothing. Both mean text that no element
    // claims, so no `lang` covers it and nothing here can speak for the document.
    const tag = START_TAG.exec(segment);
    if (!tag) return null;
    if (NO_TEXT_OF_ITS_OWN.has(tag[1]!.toLowerCase())) continue;
    const lang = preferredTag((attrValue(tag[2]!, "lang") ?? "").trim());
    if (!lang) return null;
    if (agreed && agreed.toLowerCase() !== lang.toLowerCase()) return null;
    agreed ??= lang;
  }
  return agreed;
}

// Wrap body content in a minimal accessible document shell. If issues remain when the
// review loop stops — at its cap, or on a round that changed nothing — they are recorded
// as an HTML comment (invisible to users, but in the document for tooling); the full list
// also persists in unresolved.md.
//
// `failedPages` is recorded the same way, and for a reason worth spelling out: the
// per-page marker `failedPage` writes lives INSIDE a fragment, so it is part of the body
// handed to the Copy Editor with "return the complete corrected body" — a round that
// rewrites the document may drop it, leaving a document missing a page with nothing in it
// to say so, which is exactly what that marker exists to prevent. Injected here, after
// the loop, it is out of the editor's reach for the same reason @unresolved is. The
// in-body marker stays because it says WHERE the hole is; this one guarantees the
// document admits there is one.
// `editorTruncated` is the third statement of the same kind, and it is about the loop
// rather than about the content: a correction round's response hit the model's output
// ceiling (issue #143). Without it, a document delivered this way is indistinguishable from
// one whose issues the editor tried and failed to fix — and the difference is what a reader
// of `@unresolved` needs.
// `editorSections` says how that round then ended, and there are two ways (issue #165). With
// it, the round was re-made a section at a time and this document carries whatever those
// sections fixed — so the `@unresolved` list is the reading that PRECEDED them and was never
// taken again. Without it, nothing was rescued: the round was abandoned and this document is
// the one that entered it, with those issues never worked on at all. Two different documents,
// and a reader who is told "a round was abandoned" about the first would go looking for
// corrections that are in fact there.
// `lintUnavailable` is the fourth statement of the same kind, and the one that is about
// the CHECKING rather than about the content: axe-core could not run on this document, so
// nothing here has been through the accessibility gate at all. It belongs in the document
// for the same reason the others do — a document delivered this way is otherwise
// indistinguishable from one the linter cleared, and the person who receives it is the one
// who most needs to know which they have. It is the delivered half of #164: the log line
// says it to an operator, this says it to whoever opens the file.
export function wrapDocument(
  body: string,
  opts: {
    unresolved?: string[];
    failedPages?: number[];
    editorTruncated?: boolean;
    editorSections?: { of: number; corrected: number };
    lintUnavailable?: string;
  } = {},
): string {
  const unresolved = opts.unresolved?.length
    ? `\n<!-- @unresolved\n${opts.unresolved.map((u) => `  - ${u.replace(/--+/g, "—")}`).join("\n")}\n-->`
    : "";
  const failed = opts.failedPages?.length
    ? `\n<!-- @page-failed ${opts.failedPages.join(", ")}\n` +
      `  This document is incomplete: the source pages above could not be extracted and\n` +
      `  none of their content is here. See the run log (page_extraction_failed) or the\n` +
      `  session's diagnostics (pages_failed) for why.\n-->`
    : "";
  const truncated = !opts.editorTruncated
    ? ""
    : opts.editorSections
      ? `\n<!-- @editor-truncated sections ${opts.editorSections.corrected} of ${opts.editorSections.of}\n` +
        `  A correction round could not be completed in one response: the copy editor is asked\n` +
        `  for the whole document, and the answer hit the model's output ceiling. It was made\n` +
        `  again a section at a time, and the corrections above are what came back — from\n` +
        `  requests that each saw one section of the document and not the rest of it, so a\n` +
        `  problem spanning two of them may be untouched. The review loop then stopped, so any\n` +
        `  issues listed below are the ones found BEFORE those corrections and were not looked\n` +
        `  for again; some may already be fixed. See the run log (editor_truncated,\n` +
        `  editor_sections) for the ceiling, the size of the response and the sections.\n-->`
      : `\n<!-- @editor-truncated\n` +
        `  A correction round could not be completed: the copy editor is asked for the whole\n` +
        `  document, and its response hit the model's output ceiling, so that round was\n` +
        `  discarded and the review loop stopped. The content below is what entered that\n` +
        `  round; any issues listed below were not corrected. See the run log\n` +
        `  (editor_truncated, editor_sections_declined) for the ceiling, the size of the\n` +
        `  response and why it could not be corrected a section at a time.\n-->`;
  // The message is axe's own, and it is the only text here that comes from outside this
  // function — `runAxe` builds it from an Error's `message`, so it can be long, can carry a
  // newline, and would otherwise be able to close this comment early. Bounded like the
  // extraction note, and `--` folded the way @unresolved folds it, taking any `>` with it so
  // the fold reads as prose: a marker that says the gate did not run must not be a marker
  // that breaks the document saying so.
  const unlinted = opts.lintUnavailable
    ? `\n<!-- @lint-unavailable\n` +
      `  This document has NOT been checked for accessibility violations: axe-core could\n` +
      `  not run on it, so the absence of reported violations here is not evidence that\n` +
      `  there are none. Everything else in this document was produced and reviewed as\n` +
      `  usual. See the run log (assembly / lint_unavailable) for the failure.\n` +
      `  ${opts.lintUnavailable.slice(0, 300).replace(/\s+/g, " ").replace(/--+>?/g, "—")}\n-->`
    : "";
  const lang = bodyLang(body) ?? "en";
  // The one English string in the shell, labelled where the document around it is not English —
  // otherwise the title inherits a root that is now telling the truth about the pages and lying
  // about it (WCAG 3.1.2, and a screen reader reading the tab or the document title aloud).
  // The label is about THIS string, and only survives as long as it does: `GET /output` replaces the
  // title's text with the uploaded file's name, whose language nobody here can vouch for, and drops
  // the attribute with it (`titledAs`, util/outputNames.ts).
  const titleLang = /^en(?:-|$)/i.test(lang) ? "" : ` lang="en"`;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <title${titleLang}>Accessible document</title>
</head>
<body>
<main>
${body}
</main>${failed}${truncated}${unlinted}${unresolved}
</body>
</html>
`;
}

export async function runAssembly(
  ctx: PipelineContext,
  fragments: Fragment[],
  opts: { unresolved?: string[] } = {},
): Promise<AssemblyResult> {
  const { body, anchors, deprecatedRoles } = assembleBodyWithReport(fragments);
  const html = wrapDocument(body, opts);
  const lint = await runAxe(html);
  // `lint_error` is logged because a gate that could not run has to be distinguishable
  // from one that found nothing — and for a while this line was the only thing that made
  // it so, because `runAxe` reported the environment failure as `ok: true, violations: []`
  // and the two readings of `lint_ok: true` came apart here. They no longer do: a lint that
  // threw is `lint_ok: false` with no `violations` figure at all (#164, see LintResult). The
  // fields below are still logged, and are still the useful half — WHICH failure it was, on
  // a line an operator reads without opening the document.
  //
  // The failure is reachable two ways, neither theoretical. `anchors.ts` delivers a page too
  // deeply nested to rewrite, its nesting reaches the linted document, and axe overflows on
  // it from a few thousand levels — precisely the document whose delivered-as-written page
  // may still carry the duplicate ids the join could not fix. And a single attribute name
  // that begins with a digit anywhere in the document makes jsdom's selector engine emit
  // JavaScript it cannot compile (see runAxe), which is what #144 and #164 hit on real
  // output. Same disclosure argument as `pinned_ids` below.
  //
  // The message alone turned out not to be enough. The first real occurrence (#144) read
  // "Octal escape sequences are not allowed in strict mode" — a JavaScript SyntaxError,
  // which is neither the overflow above nor anything anyone could reproduce from that
  // sentence — so `runAxe` now also reports which step threw, its error class and the
  // first frames of its stack, and all three are logged here. The document that provoked
  // it is recoverable too, without keeping a second copy of it: this lints
  // `wrapDocument(assembleBody(fragments))`, both of which are pure, and
  // `fragments.json` is written before this phase runs.
  ctx.log.event("assembly", {
    pages: fragments.length,
    lint_ok: lint.ok,
    // Omitted, not zeroed, when the lint did not run: the count of violations in a check
    // that did not happen is unknown. `violations: 0` here was the specific value #164 was
    // filed about — read beside `lint_ok: true` it was a clean bill of health for a document
    // axe had not looked at, and anything tallying these lines summed it as a real zero.
    // Omission follows the convention the `lint_error*` fields above already use: a field
    // that has nothing to say is absent, so a field that is present means something.
    ...(lint.violations ? { violations: lint.violations.length } : {}),
    ...lintErrorFields(lint),
  });
  // Logged only when the join actually had to do something, so the ordinary run adds
  // no line. `ambiguous` is the one that matters to a human: a reference naming an id
  // that two pages claimed is repointed at the first of them, which is what the
  // un-namespaced document resolved it to, but no page vouches for that being the
  // copy it meant — worth an eye, and without this line there is no symptom at all.
  // `skipped_pages` means a page was left exactly as written rather than risk losing
  // markup on reserialization, so it may still carry a collision (lint's
  // `duplicate-id` / `duplicate-id-active` names that) or a reference that others
  // renamed away from. `pinned_ids` is the same kind of disclosure one level down: those
  // ids collided and their FIRST owner was left bare on purpose, so that a reference
  // frozen on an unrewritable page keeps resolving. Without it, `collisions` would claim
  // an id was namespaced when it deliberately was not.
  // Logged only when something was removed, like `assembly_anchors`. It is worth a line
  // rather than being silent: this is the prompt's FOOTNOTES rule not being followed, and
  // the log is the only place that fact survives — the delivered document is clean and the
  // lint that would have named the role now finds nothing. `roles` is the set and `nodes`
  // the count, which is what `aria-deprecated-role` would have reported.
  if (deprecatedRoles.nodes > 0) {
    ctx.log.event("deprecated_roles_stripped", {
      stage: "assembly",
      roles: [...new Set(deprecatedRoles.stripped)].sort(),
      nodes: deprecatedRoles.nodes,
    });
  }
  if (anchors.collisions.length > 0 || anchors.ambiguous.length > 0) {
    ctx.log.event("assembly_anchors", {
      collisions: anchors.collisions,
      pinned_ids: anchors.pinned_ids,
      ambiguous: anchors.ambiguous.map((u) => `page ${u.page}: #${u.ref}`),
      skipped_pages: anchors.skipped_pages,
    });
  }
  return { html, body, lint };
}
