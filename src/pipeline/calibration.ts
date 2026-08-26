import { JSDOM, VirtualConsole } from "jsdom";
import { mapWithConcurrency } from "../util/concurrency.ts";
import type { AgentSpec } from "../agents/loader.ts";
import type { InputImage, PipelineContext } from "./context.ts";
import { verifyAgentOutput, VERIFY_KINDS, type VerifyKind, type VerifyVerdict } from "./feedback.ts";

// Does the fidelity verifier DISCRIMINATE? (issue #180)
//
// Fidelity is checked exactly once per page, by the Feedback Agent's VERIFY task, and
// everything the pipeline claims about accuracy rests on that verdict. Every measurement of
// it so far puts its rejection rate near four pages in five: 58 of 75 across three 25-page
// runs (#137, cited in `correction.ts`), then 76 of 100 and 74 of 94 in two benchmark rounds
// (#182, cited in `test/verify-kinds.test.ts`). Two explanations fit that number equally
// well — the extraction really does need correcting on most pages, or the verifier is
// calibrated to find something and finds something. The verdict cannot answer that question
// about itself, which `correction.ts` says in as many words.
//
// So this asks it from outside. Take pages the verifier passed, damage one thing in a copy of
// each, and put both copies back to the same verifier against the same image. Two rates come
// out — how often it passes a clean page, and how often it catches a defect it was handed —
// and the per-defect breakdown is the actionable part either way: "it catches dropped tables
// and misses changed numbers" is a sentence about `agents/feedback.md` that no aggregate
// rejection rate can produce.
//
// This file is the measurement, not a gate. Nothing in the pipeline imports it; `src/tools`
// has the CLI that runs it and prints the report.
//
// The damage is done to HTML rather than to the image on purpose: the verifier's job is to
// compare an agent's output against the page, so the injected defect has to be a defect OF
// THE OUTPUT. Every injector below is a change a real extraction failure produces — a row
// that did not survive, a number transcribed wrong, a heading flattened, alt text dropped, a
// page returned in part.

// A defect that can be injected into a page's HTML.
export interface DefectSpec {
  id: string;
  // What was done, one line, for the report. Read alongside the caught/missed counts.
  what: string;
  // The `kind` a verifier that actually saw this defect should tag its problem with
  // (`VERIFY_KINDS`). More than one where the honest answer is more than one: a dropped
  // heading is content that is gone AND structure that changed, and `agents/feedback.md`
  // tells the agent the earliest applicable kind wins, so both are correct tags.
  //
  // This is the weaker of the two signals reported and is treated as such: a verifier that
  // rejects the damaged copy has caught it, and one that also tags it the way this list
  // predicts has named it. A mismatch here is a labelling disagreement, not a miss.
  expects: VerifyKind[];
  // The damaged copy, or null where the page has no such structure to damage. Never a
  // silent no-op: a returned string is always different from its input, and the report
  // counts how many pages each defect could not be applied to.
  damage(html: string): string | null;
}

function parse(html: string): Document | null {
  try {
    return new JSDOM(`<body>${html}</body>`, { virtualConsole: new VirtualConsole() }).window.document;
  } catch {
    return null;
  }
}

// The injectors all end here: serialize, and refuse the case where the edit changed
// nothing. An injector that silently returns its input would be counted as a defect the
// verifier missed, which is the one direction of error this whole measurement cannot
// afford — it would read as the verifier failing a test it was never given.
function serialize(doc: Document, original: string): string | null {
  const out = doc.body.innerHTML;
  return out.trim() && out !== original ? out : null;
}

// Elements in document order, as a plain array (a NodeList is live for some queries and
// the injectors mutate as they go).
function all<T extends Element>(doc: Document, selector: string): T[] {
  return Array.from(doc.querySelectorAll(selector)) as T[];
}

const HEADINGS = "h1, h2, h3, h4, h5, h6";

// Rows that carry data rather than headers. A row of nothing but `<th>` is the header row,
// and dropping it is a different defect (structure, not content) that this list does not
// claim to inject.
function bodyRows(table: Element): Element[] {
  return Array.from(table.querySelectorAll("tr")).filter((r) => {
    if (r.closest("table") !== table) return false; // nested table's row
    const cells = Array.from(r.children).filter((c) => /^(td|th)$/i.test(c.tagName));
    return cells.length > 0 && !cells.every((c) => c.tagName.toLowerCase() === "th");
  });
}

// Rename an element in place, keeping its attributes, its children and its position. Used
// for the heading demotion, where replacing the element is the only way to change its level.
function rename(doc: Document, el: Element, tag: string): Element {
  const next = doc.createElement(tag);
  for (const attr of Array.from(el.attributes)) next.setAttribute(attr.name, attr.value);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.parentNode?.replaceChild(next, el);
  return next;
}

// The fixed list from the issue. Fixed on purpose: a defect list that grows with what the
// verifier turns out to miss measures the list rather than the verifier.
export const DEFECTS: DefectSpec[] = [
  {
    id: "drop_table_row",
    what: "the last data row of the first table is removed",
    // The row's words are gone from the document; nothing about it is merely restructured.
    expects: ["content_missing"],
    damage(html) {
      const doc = parse(html);
      if (!doc) return null;
      for (const table of all(doc, "table")) {
        const rows = bodyRows(table);
        // Two, so the table still reads as a table afterwards: removing the only data row
        // leaves a header with nothing under it, which is a different defect and one the
        // "drop the whole table" case below already covers better.
        if (rows.length < 2) continue;
        rows[rows.length - 1].remove();
        return serialize(doc, html);
      }
      return null;
    },
  },
  {
    id: "drop_table",
    what: "the first table is removed entirely",
    expects: ["content_missing"],
    damage(html) {
      const doc = parse(html);
      if (!doc) return null;
      const table = doc.querySelector("table");
      if (!table) return null;
      table.remove();
      return serialize(doc, html);
    },
  },
  {
    id: "change_cell_number",
    what: "a number in a table cell is changed to a different number",
    // The words are all still there and the structure is untouched; one of them is false.
    // This is the defect a reader cannot detect from the document alone, and the one that
    // matters most in the documents Iris takes as input — a torque figure, a dose, a price.
    expects: ["content_wrong"],
    damage(html) {
      const doc = parse(html);
      if (!doc) return null;
      for (const cell of all(doc, "td, th")) {
        const text = cell.textContent ?? "";
        const m = /\d+/.exec(text);
        if (!m) continue;
        // The last digit, moved by one, so the change is a plausible transcription error
        // rather than a nonsense string: 3 -> 4, 250 -> 251, 2019 -> 2018 (9 wraps down so
        // the digit count never changes and no leading zero appears).
        const digits = m[0];
        const last = Number(digits[digits.length - 1]);
        const moved = digits.slice(0, -1) + String(last === 9 ? 8 : last + 1);
        if (moved === digits) continue;
        // Replaced in the cell's own text nodes, so markup inside the cell survives.
        const walk = (node: Node): boolean => {
          if (node.nodeType === 3) {
            const t = node.textContent ?? "";
            const at = t.indexOf(digits);
            if (at === -1) return false;
            node.textContent = t.slice(0, at) + moved + t.slice(at + digits.length);
            return true;
          }
          for (const child of Array.from(node.childNodes)) if (walk(child)) return true;
          return false;
        };
        if (walk(cell)) return serialize(doc, html);
      }
      return null;
    },
  },
  {
    id: "drop_heading",
    what: "a heading is removed, leaving the content that was under it",
    // Its words are gone and the section it opened has lost its boundary. Either tag is a
    // verifier that saw the defect.
    expects: ["content_missing", "structure_wrong"],
    damage(html) {
      const doc = parse(html);
      if (!doc) return null;
      const headings = all(doc, HEADINGS);
      if (!headings.length) return null;
      // The second where there is one: removing the only heading on a page is also the
      // hardest case to attribute, since a page whose title is its first line legitimately
      // renders without one.
      (headings[1] ?? headings[0]).remove();
      return serialize(doc, html);
    },
  },
  {
    id: "demote_heading",
    what: "a heading is demoted two levels, breaking the nesting order",
    // Every word survives; what changes is where a reader navigating by heading is told
    // they are. axe reports a skipped level, so this is also the one defect on the list
    // that the gate can catch without the verifier — which is worth knowing separately.
    expects: ["structure_wrong"],
    damage(html) {
      const doc = parse(html);
      if (!doc) return null;
      for (const h of all(doc, HEADINGS)) {
        const level = Number(h.tagName[1]);
        if (level > 4) continue; // no room to demote by two
        rename(doc, h, `h${level + 2}`);
        return serialize(doc, html);
      }
      return null;
    },
  },
  {
    id: "remove_alt",
    what: "the alt text of an image is removed",
    // `alt_quality` is the kind for alt text that is thin or wrong; an image with no alt
    // attribute at all is the accessibility defect, and both are verdicts that saw it.
    expects: ["a11y_only", "alt_quality"],
    damage(html) {
      const doc = parse(html);
      if (!doc) return null;
      // A non-empty alt: `alt=""` is correct markup for a decorative image, so removing
      // that one is a defect the verifier is right to weigh differently.
      const img = all(doc, "img").find((i) => (i.getAttribute("alt") ?? "").trim());
      if (!img) return null;
      img.removeAttribute("alt");
      return serialize(doc, html);
    },
  },
  {
    id: "swap_paragraphs",
    what: "two neighbouring paragraphs are swapped",
    // Reading order, which is the property this pipeline exists to protect and the one a
    // word-counting check cannot see: both paragraphs are present, in the wrong order.
    expects: ["structure_wrong", "content_wrong"],
    damage(html) {
      const doc = parse(html);
      if (!doc) return null;
      for (const p of all(doc, "p")) {
        const next = p.nextElementSibling;
        if (!next || next.tagName.toLowerCase() !== "p") continue;
        p.parentNode?.insertBefore(next, p);
        return serialize(doc, html);
      }
      return null;
    },
  },
  {
    id: "truncate_tail",
    what: "the last third of the page's top-level blocks is dropped",
    // The shape a page takes when the model runs out of output tokens, which is a real and
    // measured failure of this pipeline (#135, #159) and the one the page prompt asks for a
    // [page not fully transcribed] marker about. Here it arrives with no marker.
    expects: ["content_missing"],
    damage(html) {
      const doc = parse(html);
      if (!doc) return null;
      // Top level as the model wrote it, and one level in where the page is wrapped in a
      // single container (`<article>`, `<main>`, a `<div>`) — otherwise the whole page is
      // one child and the third to drop is either nothing or everything.
      let blocks = Array.from(doc.body.children);
      while (blocks.length === 1 && blocks[0].children.length > 1) blocks = Array.from(blocks[0].children);
      if (blocks.length < 3) return null;
      const keep = Math.ceil((blocks.length * 2) / 3);
      for (const el of blocks.slice(keep)) el.remove();
      return serialize(doc, html);
    },
  },
];

// One page's own output, as the verifier passed it. `html` is the page fragment (a
// fragment's `innerHtml`, which is what `verifyAgentOutput` is given in the pipeline).
export interface CalibrationPage {
  image: InputImage;
  html: string;
  // The contract this page's HTML was actually written to, where it is not the current
  // one. VERIFY is handed the agent's whole contract and judges the output against it, so
  // a page extracted under an older `agents/page.md` and judged against today's can be
  // rejected for breaking a rule that did not exist when it was written — which is the
  // verifier being right, and would be counted here as a false positive. The verifier
  // itself (`agents/feedback.md`) is always the current one: today's judge is what is
  // being measured.
  agent?: AgentSpec;
}

// What one VERIFY call said, flattened to what this measurement reads.
export interface Judgement {
  ok: boolean;
  problems: string[];
  kinds: VerifyKind[];
  untagged: number;
  // The call produced no judgement at all — no Feedback Agent, nothing to verify, or a
  // reply that could not be parsed. `verifyAgentOutput` answers ok=true in those cases so
  // that verification never breaks a run, which means "passed" and "could not be judged"
  // are the same observation at that interface. Counting the second as a pass would
  // overstate exactly the number this file exists to measure, so it is carried separately
  // and excluded from both rates.
  unjudged: boolean;
}

export interface CalibrationRow {
  image: string;
  // The blob SHA of the contract this page was judged against, or null for one with no
  // upstream object. Recorded per row because it can differ per page: a corpus pooled from
  // several sessions is a corpus of several contracts.
  contract: string | null;
  clean: Judgement;
  // Absent where no defect on the list applies to this page — a page of prose has no table
  // row to drop. Never a silent skip: `skipped` says which pages and why.
  defect?: string;
  damaged?: Judgement;
  skipped?: string;
}

export interface DefectTally {
  applied: number;
  // The damaged copy was rejected: ok=false with at least one problem named, which is the
  // same test `failedCheck` applies before the pipeline spends a correction call.
  caught: number;
  // Rejected AND tagged with one of the kinds this defect predicts.
  named: number;
  unjudged: number;
}

export interface CalibrationReport {
  pages: number;
  rows: CalibrationRow[];
  clean: { passed: number; failed: number; unjudged: number };
  perDefect: Record<string, DefectTally>;
  // Pages no defect applied to, with the reason. Read with `pages`: a report over 20 pages
  // where 6 were skipped is a report over 14.
  skipped: { image: string; reason: string }[];
}

// The same test the pipeline applies before it spends a correction call
// (`failedCheck` in extraction.ts): a verdict with no problems in it is not actionable,
// whatever the flag says.
function rejected(j: Judgement): boolean {
  return !j.unjudged && !j.ok && j.problems.length > 0;
}

function judge(v: VerifyVerdict): Judgement {
  return { ok: v.ok, problems: v.problems, kinds: v.kinds, untagged: v.untagged, unjudged: v.unjudged === true };
}

export interface CalibrateOptions {
  // How defects are handed out. "rotate" gives each page one defect, cycling through the
  // list in order, which is the 2N calls the issue costs out. "all" applies every
  // applicable defect to every page — a fuller per-defect breakdown for (1 + defects) calls
  // a page, which on eight defects is nine times the bill.
  defects?: "rotate" | "all";
  // Which defects to consider, by id. Defaults to all of `DEFECTS`.
  only?: string[];
  // Model calls in flight, as elsewhere in the pipeline.
  concurrency?: number;
}

// Run the calibration. Every page costs one verify call for the clean copy plus one per
// damaged copy, and nothing here is cached: the point is a fresh verdict on each.
export async function calibrateVerifier(
  ctx: PipelineContext,
  agent: AgentSpec,
  pages: CalibrationPage[],
  opts: CalibrateOptions = {},
): Promise<CalibrationReport> {
  const list = opts.only?.length ? DEFECTS.filter((d) => opts.only!.includes(d.id)) : DEFECTS;
  const mode = opts.defects ?? "rotate";
  const limit = Math.max(1, Math.floor(opts.concurrency ?? ctx.extractionConcurrency) || 1);

  // Which defects to try on which page, decided before any call so the plan is reportable
  // and so a rotation is a rotation rather than whatever order the calls happened to
  // finish in. In "rotate" mode the offset walks with the page index, so a corpus where
  // half the pages have no table still spreads the other defects over the pages that do.
  const plan = pages.map((page, i) => {
    const applicable: { defect: DefectSpec; html: string }[] = [];
    for (let k = 0; k < list.length; k++) {
      const defect = list[(i + k) % list.length];
      const damaged = defect.damage(page.html);
      if (!damaged) continue;
      applicable.push({ defect, html: damaged });
      if (mode === "rotate") break;
    }
    return { page, applicable };
  });

  const perDefect: Record<string, DefectTally> = {};
  for (const d of list) perDefect[d.id] = { applied: 0, caught: 0, named: 0, unjudged: 0 };

  // One unit of work per verify call, so the whole run is bounded by `limit` rather than by
  // `limit` pages each issuing several calls at once.
  type Call = { pageIndex: number; defect?: DefectSpec; html: string };
  const calls: Call[] = [];
  plan.forEach((p, pageIndex) => {
    calls.push({ pageIndex, html: p.page.html });
    for (const a of p.applicable) calls.push({ pageIndex, defect: a.defect, html: a.html });
  });

  const verdicts = await mapWithConcurrency(calls, limit, async (call) => {
    const page = plan[call.pageIndex].page;
    // The page's own contract where it has one, so a clean copy is judged against the
    // rules it was written to and not against rules added since.
    const verdict = await verifyAgentOutput(ctx, page.agent ?? agent, page.image, [{ html: call.html }]);
    return judge(verdict);
  });

  const rows: CalibrationRow[] = [];
  const clean = { passed: 0, failed: 0, unjudged: 0 };
  const skipped: { image: string; reason: string }[] = [];

  plan.forEach((p, pageIndex) => {
    const own = calls.map((c, i) => ({ c, j: verdicts[i] })).filter(({ c }) => c.pageIndex === pageIndex);
    const cleanJudgement = own.find(({ c }) => !c.defect)!.j;
    const contract = (p.page.agent ?? agent).sha;
    if (cleanJudgement.unjudged) clean.unjudged += 1;
    else if (rejected(cleanJudgement)) clean.failed += 1;
    else clean.passed += 1;

    if (!p.applicable.length) {
      const reason = "no defect on the list applies to this page";
      skipped.push({ image: p.page.image.name, reason });
      rows.push({ image: p.page.image.name, contract, clean: cleanJudgement, skipped: reason });
      return;
    }
    for (const { c, j } of own) {
      if (!c.defect) continue;
      const tally = perDefect[c.defect.id];
      tally.applied += 1;
      if (j.unjudged) tally.unjudged += 1;
      else if (rejected(j)) {
        tally.caught += 1;
        if (c.defect.expects.some((k) => j.kinds.includes(k))) tally.named += 1;
      }
      rows.push({ image: p.page.image.name, contract, clean: cleanJudgement, defect: c.defect.id, damaged: j });
    }
  });

  return { pages: pages.length, rows, clean, perDefect, skipped };
}

const pct = (n: number, of: number): string => (of === 0 ? "n/a" : `${Math.round((n / of) * 100)}%`);

// The report as text. Written to be readable in a terminal and quotable into the issue,
// which is what it is for: the numbers are the deliverable, not a threshold anything
// compares against.
export function formatCalibration(r: CalibrationReport): string {
  const judged = r.clean.passed + r.clean.failed;
  const out: string[] = [];
  out.push(`Pages: ${r.pages} (${judged} judged, ${r.clean.unjudged} unjudged)`);
  out.push(
    `Clean copies: ${r.clean.passed} passed, ${r.clean.failed} rejected` +
      ` — false-positive rate ${pct(r.clean.failed, judged)}`,
  );
  out.push("");
  out.push("Defect                 applied  caught  named  unjudged");
  const totals = { applied: 0, caught: 0, named: 0, unjudged: 0 };
  for (const d of DEFECTS) {
    const t = r.perDefect[d.id];
    if (!t) continue;
    totals.applied += t.applied;
    totals.caught += t.caught;
    totals.named += t.named;
    totals.unjudged += t.unjudged;
    const rate = t.applied - t.unjudged > 0 ? ` (${pct(t.caught, t.applied - t.unjudged)})` : "";
    out.push(
      `${d.id.padEnd(22)} ${String(t.applied).padStart(7)} ${String(t.caught).padStart(7)}` +
        ` ${String(t.named).padStart(6)} ${String(t.unjudged).padStart(9)}${rate}`,
    );
  }
  const judgedDamaged = totals.applied - totals.unjudged;
  out.push("");
  out.push(
    `Damaged copies: ${totals.caught} of ${judgedDamaged} caught (${pct(totals.caught, judgedDamaged)})` +
      `, ${totals.named} tagged with a kind the defect predicts`,
  );
  // Said out loud rather than left to be inferred from the counts: a defect that never got
  // applied has not been measured, and a corpus that skipped a third of its pages is a
  // smaller corpus than the page count above.
  //
  // "in this run" and not "no page had the structure": in rotate mode a page stops at the
  // first defect that applies to it, so a zero here can mean the corpus had nowhere to put
  // this defect OR that the rotation never got to it. The tool's dry run separates those
  // two; a reader of the report only needs to know the row was not measured.
  const never = DEFECTS.filter((d) => (r.perDefect[d.id]?.applied ?? 0) === 0).map((d) => d.id);
  if (never.length) out.push(`Never applied in this run (not measured): ${never.join(", ")}`);
  if (r.skipped.length) out.push(`Pages with no applicable defect: ${r.skipped.length} of ${r.pages}`);
  if (totals.unjudged || r.clean.unjudged) {
    out.push(
      `Unjudged calls are excluded from every rate above: ${r.clean.unjudged} clean, ${totals.unjudged} damaged.`,
    );
  }
  // Which contract each page was judged against. Not decoration: the clean-copy rate is
  // only a false-positive rate if the pages were judged against the rules they were
  // written to, and a corpus pooled from several sessions can be a corpus of several
  // contracts. A reader comparing two runs of this needs to know it.
  const contracts = [...new Set(r.rows.map((row) => row.contract ?? "(no upstream object)"))];
  out.push(`Contract judged against: ${contracts.map((c) => c.slice(0, 12)).join(", ")}`);
  return out.join("\n");
}

// Exported for the tool's `--defects` argument, so an unknown id fails before any model
// call rather than silently narrowing the run.
export const DEFECT_IDS: string[] = DEFECTS.map((d) => d.id);

// Kept honest against `VERIFY_KINDS`: a defect predicting a kind the verifier's contract
// does not define would never be counted as named, and the report would read as the
// verifier failing to tag rather than as this file naming a kind that does not exist.
for (const d of DEFECTS) {
  for (const k of d.expects) {
    if (!VERIFY_KINDS.includes(k)) throw new Error(`defect ${d.id} expects unknown verify kind "${k}"`);
  }
}
