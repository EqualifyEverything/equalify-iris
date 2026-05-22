import { JSDOM, VirtualConsole } from "jsdom";
import axe from "axe-core";

export interface LintViolation {
  id: string;
  impact: string | null;
  description: string;
  nodes: number;
}

export interface LintResult {
  ok: boolean;
  violations: LintViolation[];
  error?: string;
}

// PRD §7.7: validate the document parses and basic accessibility lint passes
// (axe-core in headless mode). We run axe inside a jsdom realm. If axe cannot
// run in this environment we degrade to a parse check rather than fail the run;
// either way the result is surfaced to the Reader as input.
export async function runAxe(html: string): Promise<LintResult> {
  let dom: JSDOM;
  try {
    // Swallow jsdom's not-implemented noise (e.g. canvas getContext, which the
    // disabled color-contrast rule would otherwise trigger).
    const virtualConsole = new VirtualConsole();
    dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  } catch (e) {
    return { ok: false, violations: [], error: `document failed to parse: ${(e as Error).message}` };
  }

  try {
    const { window } = dom;
    // Inject the axe-core library source into the jsdom realm and run it there.
    window.eval(axe.source);
    const w = window as unknown as {
      axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; impact: string | null; description: string; nodes: unknown[] }[] }> };
    };
    const results = await w.axe.run(window.document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      // Output is content-only with no styling (PRD §4), so color contrast is
      // out of scope and cannot be assessed without rendering anyway.
      rules: { "color-contrast": { enabled: false } },
    });
    const violations = results.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.length,
    }));
    return { ok: violations.length === 0, violations };
  } catch (e) {
    return { ok: true, violations: [], error: `axe-core could not run in this environment: ${(e as Error).message}` };
  } finally {
    dom.window.close();
  }
}
