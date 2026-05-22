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

  const unresolvedBlock = opts.unresolved?.length
    ? `\n\n<!-- @unresolved -->\n<aside aria-label="Unresolved issues">\n<h2>Unresolved issues</h2>\n<ul>\n${opts.unresolved
        .map((u) => `  <li>${escapeHtml(u)}</li>`)
        .join("\n")}\n</ul>\n</aside>`
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
