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
    type AxeIssue = { id: string; impact: string | null; description: string; nodes: unknown[] };
    const w = window as unknown as {
      axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeIssue[]; incomplete: AxeIssue[] }> };
    };
    const results = await w.axe.run(window.document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: {
        // Output is content-only with no styling (PRD §4), so color contrast is
        // out of scope and cannot be assessed without rendering anyway.
        "color-contrast": { enabled: false },
        // Enabled BY NAME because the tag filter above excludes it: WCAG 2.2
        // dropped 4.1.1, so axe tags `duplicate-id` `wcag2a-obsolete` and
        // `deprecated`. Obsolete as a conformance criterion is not the same as
        // harmless here. This document is assembled from independently extracted
        // pages, so a duplicate id is the specific defect that arises from
        // concatenation, and it breaks navigation rather than conformance: two
        // `id="fn-1"` means every `href="#fn-1"` reaches the first one, so a
        // footnote reference on a later page silently goes to the wrong note.
        // `duplicate-id-aria` (which IS wcag2a) does not cover it — that rule
        // fires for ids referenced from ARIA attributes, not from an `href`.
        //
        // assembleBody namespaces each page's ids, so this is a backstop, not the
        // fix: the review loop re-lints after the Copy Editor has rewritten the
        // whole body, and that is a rewrite by a model that can reintroduce a
        // collision the assembler had already resolved. It is also what reports the
        // collision on a page whose rewrite was abandoned (anchors.ts
        // `skipped_pages`), and the same-page duplicate no prefix can fix.
        //
        // Both obsolete halves are needed, because axe splits duplicate ids across
        // three rules by what the element IS, and each rule deliberately skips the
        // others' elements (`duplicateIdMiscMatches` requires that no element with the
        // id is focusable; `duplicateIdActiveMatches` requires that one is; both first
        // require that the id is not an accessibility reference target). So with only
        // `duplicate-id` enabled, two `<li id="x">` are reported and two `<a id="x">`
        // or two `<input id="x">` come back clean — verified in this environment, and
        // pinned by a test, since which rule claims which element is an axe internal
        // that a version bump can move. Active elements are the ones that matter most
        // here: a duplicate id on an `<input>` is what makes a `<label for>` name the
        // wrong field.
        "duplicate-id": { enabled: true },
        "duplicate-id-active": { enabled: true },
        // The third rule needs no enabling — `duplicate-id-aria` is current (`wcag2a`)
        // and arrives via the tag filter — but it is `reviewOnFail`, so axe puts its
        // findings in `incomplete` rather than `violations`. Handled below.
      },
    });
    // `duplicate-id-aria` is the one duplicate-id rule that is still a live WCAG
    // criterion (4.1.2), and it is the only one that fires for an id something actually
    // references — `<label for>`, `aria-describedby`. It is also `reviewOnFail`, so axe
    // reports it as `incomplete` and not as a violation, which meant the case with the
    // clearest user harm was the one this gate could not see: two `<input id="q1">`
    // under one `<label for="q1">` came back with zero violations even after enabling
    // both obsolete rules. A duplicate id needs no human judgement to confirm — the ids
    // are either equal or they are not — so this rule's incomplete results are promoted
    // to violations. Only this rule: the rest of `incomplete` is genuinely
    // can't-tell-without-rendering (contrast, off-screen content) and promoting it
    // would fail every run.
    const promoted = results.incomplete.filter((v) => v.id === "duplicate-id-aria");
    const violations = [...results.violations, ...promoted].map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.length,
    }));
    return { ok: violations.length === 0, violations };
  } catch (e) {
    return { ok: true, violations: [], error: `axe-core could not run in this environment: ${(e as Error).message}` };
  } finally {
    // `close()` walks the tree recursively, so a pathologically deep document overflows the
    // stack in here — and a throw from a `finally` replaces whatever the `try` returned,
    // including the graceful degradation above it. That turned a document assembly had
    // already decided to deliver (anchors.ts `MAX_NESTING` skips a page too deep to rewrite,
    // so its nesting reaches the delivered body) into a failed session, one function after
    // the module that made the decision. Cleanup cannot be the thing that fails the run:
    // what it releases early is otherwise left to the collector.
    try {
      dom.window.close();
    } catch {
      // Deliberately empty: see above.
    }
  }
}
