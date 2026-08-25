import { runAxe, lintErrorFields, type LintResult } from "./lint.ts";
import { namespaceAnchors, type AnchorReport } from "./anchors.ts";
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
export function assembleBodyWithReport(fragments: Fragment[]): { body: string; anchors: AnchorReport } {
  const ordered = [...fragments].sort((a, b) => a.order - b.order);
  const { pages, report } = namespaceAnchors(ordered.map((f) => ({ order: f.order, innerHtml: f.innerHtml.trim() })));
  return { body: pages.filter((h) => h.length > 0).join("\n\n"), anchors: report };
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
// ceiling, so that round was abandoned and this document is the one that entered it
// (issue #143). Without it, a document delivered this way is indistinguishable from one
// whose issues the editor tried and failed to fix — and the difference is what a reader
// of `@unresolved` needs, since these issues were never worked on at all.
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
  const truncated = opts.editorTruncated
    ? `\n<!-- @editor-truncated\n` +
      `  A correction round could not be completed: the copy editor is asked for the whole\n` +
      `  document, and its response hit the model's output ceiling, so that round was\n` +
      `  discarded and the review loop stopped. The content below is what entered that\n` +
      `  round; any issues listed below were not corrected. See the run log\n` +
      `  (editor_truncated) for the ceiling and the size of the response.\n-->`
    : "";
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Accessible document</title>
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
  const { body, anchors } = assembleBodyWithReport(fragments);
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
