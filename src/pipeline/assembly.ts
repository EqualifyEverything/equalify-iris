import { runAxe, type LintResult } from "./lint.ts";
import { renderFragment, type Fragment } from "./fragment.ts";
import type { PipelineContext } from "./context.ts";

export interface AssemblyResult {
  html: string;
  lint: LintResult;
}

// PRD §7.7: combine fragments into one accessible document shell in image
// order, preserving all provenance comments, then run axe-core.
export async function runAssembly(
  ctx: PipelineContext,
  fragments: Fragment[],
  opts: { unresolved?: string[] } = {},
): Promise<AssemblyResult> {
  const ordered = [...fragments].sort((a, b) => a.order - b.order);
  const body = ordered.map(renderFragment).join("\n\n");

  // Unresolved issues are recorded as a provenance COMMENT (like @source /
  // @reconciled), not visible content — so they don't show up in the rendered
  // output users see (PRD §7.11). The full list also persists in unresolved.md
  // and is available via the API. `--` is collapsed so it can't close the comment.
  const unresolvedBlock = opts.unresolved?.length
    ? `\n\n<!-- @unresolved\n${opts.unresolved
        .map((u) => `  - ${u.replace(/--+/g, "—")}`)
        .join("\n")}\n-->`
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Accessible document</title>
</head>
<body>
<main>
${body}${unresolvedBlock}
</main>
</body>
</html>
`;

  const lint = await runAxe(html);
  ctx.log.event("assembly", { fragments: ordered.length, lint_ok: lint.ok, violations: lint.violations.length });
  return { html, lint };
}
