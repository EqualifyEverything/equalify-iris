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
export function wrapDocument(body: string, opts: { unresolved?: string[] } = {}): string {
  const unresolved = opts.unresolved?.length
    ? `\n<!-- @unresolved\n${opts.unresolved.map((u) => `  - ${u.replace(/--+/g, "—")}`).join("\n")}\n-->`
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
</main>${unresolved}
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
  ctx.log.event("assembly", { pages: fragments.length, lint_ok: lint.ok, violations: lint.violations.length });
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
