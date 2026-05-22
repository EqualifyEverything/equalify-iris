import { runAxe, type LintResult } from "./lint.ts";
import type { Fragment } from "./fragment.ts";
import type { PipelineContext } from "./context.ts";

export interface AssemblyResult {
  html: string; // full document (shell + body)
  body: string; // body content only (what the review loop edits)
  lint: LintResult;
}

// Join page fragments in order into clean body content — no provenance comments
// in the delivered HTML. Per-page provenance is preserved in fragments.json.
export function assembleBody(fragments: Fragment[]): string {
  return [...fragments]
    .sort((a, b) => a.order - b.order)
    .map((f) => f.innerHtml.trim())
    .filter((h) => h.length > 0)
    .join("\n\n");
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
  const body = assembleBody(fragments);
  const html = wrapDocument(body, opts);
  const lint = await runAxe(html);
  ctx.log.event("assembly", { pages: fragments.length, lint_ok: lint.ok, violations: lint.violations.length });
  return { html, body, lint };
}
