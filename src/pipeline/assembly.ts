import { runAxe, type LintResult } from "./lint.ts";
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

// Wrap body content in a minimal accessible document shell. If issues remain at
// the review cap they are recorded as an HTML comment (invisible to users, but
// in the document for tooling); the full list also persists in unresolved.md.
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
export function wrapDocument(
  body: string,
  opts: { unresolved?: string[]; failedPages?: number[]; editorTruncated?: boolean } = {},
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Accessible document</title>
</head>
<body>
<main>
${body}
</main>${failed}${truncated}${unresolved}
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
  // `lint_error` is logged because `lint_ok: true` means two different things. When axe
  // cannot run, `runAxe` degrades to `ok: true, violations: []` with `error` set rather than
  // failing the session — so without this field a document axe never examined is recorded
  // exactly like one it cleared. That is reachable, not theoretical: `anchors.ts` delivers a
  // page too deeply nested to rewrite, its nesting reaches the linted document, and axe
  // overflows on it from a few thousand levels — precisely the document whose delivered-as-
  // written page may still carry the duplicate ids the join could not fix, recorded as clean.
  // Same disclosure argument as `pinned_ids` below: the reason a gate passed has to be
  // distinguishable from the gate having found nothing.
  //
  // The message alone turned out not to be enough. The first real occurrence (#144) read
  // "Octal escape sequences are not allowed in strict mode" — a JavaScript SyntaxError,
  // which is neither the overflow above nor anything anyone could reproduce from that
  // sentence — so `runAxe` now also reports which step threw, its error class and the
  // first frames of its stack, and all three are logged here. The document that provoked
  // it is recoverable too, without keeping a second copy of it: this lints
  // `wrapDocument(assembleBody(fragments))`, both of which are pure, and
  // `fragments.json` is written before this phase runs.
  const lintError =
    lint.error === undefined
      ? {}
      : {
          lint_error: lint.error,
          ...(lint.errorWhere ? { lint_error_where: lint.errorWhere } : {}),
          ...(lint.errorName ? { lint_error_name: lint.errorName } : {}),
          ...(lint.errorStack ? { lint_error_stack: lint.errorStack } : {}),
        };
  ctx.log.event("assembly", {
    pages: fragments.length,
    lint_ok: lint.ok,
    violations: lint.violations.length,
    ...lintError,
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
