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
  // What failed, when something did. `error` is the sentence a human and the Reader
  // Agent both read; these are for whoever has to fix it.
  //
  // A gate that degrades to "no violations" is only honest if its failure can be
  // chased down, and the first report of this happening on a real document (#144)
  // could not be: the message was "Octal escape sequences are not allowed in strict
  // mode", a JavaScript SyntaxError, which is not the case the code documented as
  // reachable (a stack overflow from a page too deeply nested) and which nobody could
  // reproduce from the message alone. `where` is what the message could not say —
  // whether the failure came out of parsing the document, out of evaluating axe's own
  // source, or out of the run — and it is a fact about which call threw rather than a
  // reading of the text, so splitting the steps below is what makes it exact.
  errorWhere?: "parse" | "inject" | "run";
  // The class of error and where it was raised. `stack` is trimmed to its first frames:
  // the top of it says which library the throw came from, which is the question, and the
  // whole thing would put a page of jsdom internals in every session's run log.
  errorName?: string;
  errorStack?: string;
}

// Enough frames to name the throwing library and its caller, and few enough that a
// degraded lint stays one log line rather than a page of it.
const STACK_FRAMES = 6;

// Frames arrive as absolute paths, and this stack is logged on the `assembly` event, which
// `GET /v1/sessions/{id}/logs` serves to the session's owner — so the deployment's directory
// layout would be disclosed to every uploader whose document degraded the gate. What the
// frames are FOR is naming the library the throw came from and its caller, and that is
// exactly what survives the trim: the install root goes, `node_modules/jsdom/lib/…` stays.
const CWD = process.cwd();
function trimPaths(stack: string): string {
  return stack
    .replaceAll(`${CWD}/`, "")
    .replace(/(?:file:\/\/)?\/\S*?node_modules\//g, "node_modules/");
}

function failure(where: "parse" | "inject" | "run", message: string, e: unknown): LintResult {
  const err = e instanceof Error ? e : undefined;
  const raw = err?.stack?.split("\n").slice(0, STACK_FRAMES + 1).join("\n");
  const stack = raw === undefined ? undefined : trimPaths(raw);
  return {
    // A document that would not parse is a failure; axe not running in this
    // environment is a degradation. Unchanged by this: only the reporting is new.
    ok: where !== "parse",
    violations: [],
    error: message,
    errorWhere: where,
    ...(err?.name ? { errorName: err.name } : {}),
    ...(stack ? { errorStack: stack } : {}),
  };
}

// PRD §7.7: validate the document parses and basic accessibility lint passes
// (axe-core in headless mode). We run axe inside a jsdom realm. If axe cannot
// run in this environment we degrade to a parse check rather than fail the run;
// either way the result is surfaced to the Reader as input.
//
// `axe-core` and `jsdom` are pinned to exact versions in package.json rather than
// carried on a caret range, and this function is the reason. It is a GATE: what it
// reports decides whether a document ships with a violation, its rule set is tuned
// against axe internals below (which rule claims which element, which findings land in
// `incomplete`), and the same rule ids are what `GET /v1/quality` reports deployment-
// wide. On a range, that behaviour can change on any redeploy with no commit to point
// at — including a change that makes a failure like #144 appear or disappear — and an
// operator investigating a checkout of the same sha could not be sure they had the same
// linter. equalify-iris-bench ports this configuration deliberately so its accuracy
// numbers mean the same thing as Iris's, which only holds if both can name one version.
export async function runAxe(html: string): Promise<LintResult> {
  let dom: JSDOM;
  try {
    // Swallow jsdom's not-implemented noise (e.g. canvas getContext, which the
    // disabled color-contrast rule would otherwise trigger).
    const virtualConsole = new VirtualConsole();
    dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  } catch (e) {
    return failure("parse", `document failed to parse: ${(e as Error).message}`, e);
  }

  type AxeIssue = { id: string; impact: string | null; description: string; nodes: unknown[] };
  type AxeWindow = {
    axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeIssue[]; incomplete: AxeIssue[] }> };
  };

  try {
    const { window } = dom;
    // Inject the axe-core library source into the jsdom realm and run it there.
    //
    // The injection is its own step, and its own catch, because it is a different
    // diagnosis from the rule pass failing: evaluating axe's source is the pipeline
    // compiling ITS dependency, which cannot depend on the document at all, while
    // `axe.run` walks the document this run produced. #144 arrived as a JavaScript
    // SyntaxError with nothing in it to say which of the two had happened — and those
    // two answers point at a version bump and at a page of HTML respectively.
    try {
      window.eval(axe.source);
    } catch (e) {
      return failure(
        "inject",
        `axe-core could not run in this environment: ${(e as Error).message}`,
        e,
      );
    }
    const w = window as unknown as AxeWindow;
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
        //
        // Enabled BY NAME on the same argument as the two above, one criterion over:
        // axe tags `heading-order` `best-practice`, so the tag filter drops it, and a
        // level this document skips on the way down is indeed not a conformance
        // failure. It is still the defect this pipeline is most exposed to. Headings
        // are how a screen-reader user navigates a long document, the levels are
        // decided one page at a time by a model looking at type size, and nothing
        // downstream could see the result: the Reader Agent never gets the source
        // images (READER_SYSTEM in review.ts), so it cannot know which heading the
        // page subordinated to which, and until now this gate passed an <h2> followed
        // by an <h4> with zero violations. `agents/page.md` has told the page agent
        // not to skip a level since #96, and #114 reported one shipped anyway — which
        // is the case for checking the output rather than only asking for it.
        //
        // The rule earns the exception by being decidable from the document alone. It
        // fires only where a level goes DOWN by more than one — verified in this
        // environment and pinned by test/lint-heading-order.test.ts, because which
        // shapes axe's `after` function reports is an internal a version bump can
        // move. In particular it stays quiet on the three shapes this pipeline
        // produces on purpose: a body that opens at <h2> or <h3>, because a page may
        // be a subsection of a heading on a page the extractor was never shown; a
        // heading that returns to an outer level after a run of subsections; and a
        // document with one heading or none. What it cannot see is the other half of
        // the same bug — an <h2> that should have been an <h3> is a level the page
        // decided, not a gap in the sequence — so this narrows the prompt's job
        // rather than replacing it.
        //
        // Iris's own quality reporting has used this rule as its worked example since
        // the tally shipped (`Store.qualityStats` in store/db.ts, docs/API.md §0c) and
        // could not once have reported it: every rule id in `run_signals` comes from
        // this call, so a rule the tag filter drops is one the weekly report can never
        // raise, however often the output breaks it.
        "heading-order": { enabled: true },
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
    return failure("run", `axe-core could not run in this environment: ${(e as Error).message}`, e);
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
