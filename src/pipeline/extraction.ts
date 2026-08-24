import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { mapWithConcurrency } from "../util/concurrency.ts";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import { feedbackPreamble, loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { verifyAgentOutput, type VerifyVerdict } from "./feedback.ts";
import {
  changedAnything,
  claimRecheck,
  correctionEffect,
  recheckSampler,
  type RecheckSampler,
} from "./correction.ts";
import { examplesForPrompt } from "./memory.ts";
import { missingLinkProblem, missingLinks, pageLinkContext, unexpectedHrefs } from "./links.ts";
import { STANDARD as STANDARD_AGENTS, isStandardType, logicalType } from "./contribute.ts";
import type { Fragment } from "./fragment.ts";

const PAGE_AGENT = "page";

// Single coherent extraction: one vision call converts the WHOLE page into one
// accessible-HTML fragment. This replaces fanning the page out to many
// content agents that each re-rendered it (which produced duplicated output for
// nested structures like forms).
//
// The nine standard content agents that fan-out used to call are no longer in the
// repo (§7.4 v1.2). They were not merely unused: `dispatchSpecialist` declines every
// name in STANDARD_AGENTS below before `loadAgent` is reached, only `page.md` is
// ever trained, and `runContribution` filters the same names — so no run could
// reach them by any path. What survives is the part that pays for itself:
// specialists for content a whole-page pass genuinely handles worse (see
// `chartDataAgent.md`), dispatched by name and merged in.
//
// The prompt now lives in agents/page.md so the page agent is a first-class,
// loadable, trainable, contributable agent (verified at build time, trained from
// feedback). This DEFAULT is used only when that file is absent, so the service
// still runs against a bare checkout. It also asks the model to flag a page that
// would benefit from a dedicated specialist agent (collected as `suggestions`).
//
// It therefore duplicates agents/page.md's "## System prompt" + "## Output
// contract" on purpose, and cannot be replaced by reading that file — the whole
// point is the file being missing. `test/page-prompt.test.ts` asserts the two
// agree (word-for-word, whitespace-insensitive), because the file is what every
// real deployment runs while this copy is exercised only by bare checkouts: edit
// one and nothing here would otherwise notice. Exported for that test.
export const DEFAULT_PAGE_PROMPT = `You convert an ENTIRE document page (provided as an image) into a single, coherent,
accessible HTML fragment that meets WCAG 2.2 AA. You see the whole page and produce ONE
faithful representation of it. NEVER duplicate content or render the same thing two ways
(for example, do not output both a <form> and a <table> for the same fields) — choose the
single structure that best matches the source.

Output ONLY the body content (no <html>, <head>, or <body> wrapper). Use the most appropriate
semantic structure for what the page actually is: headings in correct nesting order,
paragraphs, lists, tables with <caption>/<thead>/<th scope>, forms with
<label>/<fieldset>/<legend>, figures with <figcaption>, footnotes, etc. Transcribe visible
text faithfully and do not invent content: apart from the accessibility scaffolding the rules
below ask for by name — alt text, a placeholder src for a graphic you cannot embed, a <caption>
the page does not print, an accessible name on a marker the page prints as a symbol, the ↩ that
returns from a footnote, a note about irregular numbering held to what the page shows — every word
you emit is a word on the page. If content is cut off at a page edge, note it in the "log" field.

Nine structures are easy to render as something that merely looks right, so be explicit:
- HEADING LEVELS: a heading's level comes from what its content belongs to, not from how large
  or bold the page sets it. Visual weight is evidence of hierarchy, never a substitute for it: a
  smaller bold line that introduces a subsection of the section above it is an <h3> under that
  <h2>, even though a bigger, bolder heading nearby is what the eye reads as a heading. Ask what
  the content beneath this heading belongs to — if it belongs to the section the nearest
  preceding heading opened, step one level down from that heading; if it begins a section that
  stands alongside it, keep the same level; if it ends one or more subsections and resumes an
  outer section, go back to the level of the heading that opened that outer section (after an
  <h2>, <h3>, <h4> run, the next heading that belongs beside the <h3> is an <h3> again, not an
  <h4>). Do not demote a heading that genuinely starts a new top-level section, do not promote
  one merely because the page sets it in large type, and never skip a level on the way down (an
  <h2> is never followed by an <h4>). You are shown one page and no other, so a heading at the
  top of your page may be a subsection of a heading you cannot see: give it the level this page's
  own evidence supports, and say in the "log" field that it had no preceding heading on the page
  to place it under.
- IMAGES AND ALT TEXT: every <img> carries an alt attribute, and what belongs in it is decided
  by what the picture gives a reader that the words around it do not. An image is decorative —
  alt="" — only where a reader who cannot see it loses nothing: a rule, a border, a flourish, a
  bullet glyph, or a graphic whose content this page ALSO carries in full beside it (the notation
  under a stave, the data table under a chart), where describing it as well hands a screen-reader
  user the same content twice. Everything else is informative and is described: words printed
  inside the image, a logo, seal or badge, a diagram, a photograph, a chart, a cover whose
  appearance is itself the content. Sitting beside a heading that names the section does not make
  an image decorative, and neither does being hard to describe — a heading names the section, the
  alt text says what the picture shows. Where you cannot make an image out with confidence,
  describe what you can and say so in the "log" field: never leave the attribute off, and never
  leave a filename in it.
  Do not spend the description on what the page has already said. A screen reader announces a
  <figcaption>, a label and a heading as well as the alt text, so where the name of the thing
  pictured is printed beside the image — in its caption, in the label that follows it, in the
  heading a group of figures sits under — the alt text does not repeat that name; it says what the
  name does not. This is a redundancy rule and not a brevity one: every detail that is in the
  picture and not in the words around it stays. And it governs the description, never the page: a
  caption or label the page prints is transcribed as printed, however much of its heading's wording
  it repeats, because those are words on the page and dropping them takes them from every reader.
  What is forbidden is adding the repetition yourself — never extend a printed caption with the
  product, section or category name its heading already gives.
  Where the same subject is pictured more than once with no visible difference between the
  occurrences, describe them the same way and in the same detail — a fuller description of one
  tells a reader that the other differs.
  A graphic whose content is words is still a graphic: emit a logo, a masthead or a wordmark as an
  <img> with alt text (alt="Acme Corp logo"), never as a heading, a paragraph, or a transcription
  of its lettering — a logo set as an <h1> tells a reader the document is organised under it. Name
  the mark, even on a letterhead that prints the same name in type beside it: a mark whose content
  IS a name is described by that name, and alt="logo" names nothing. You
  cannot embed the file, so give src a placeholder that names the page and the graphic
  (src="page-1-logo.png") and record it in the "log" field for whatever supplies the real asset.
  Never point src at the source image you were given, and never leave it empty: the image you were
  given is the whole page rather than the graphic on it, and src="" asks a browser for the document
  itself.
- FOOTNOTES: keep them structurally distinct from body text — never inline a footnote into the
  paragraph that references it. Emit the in-text marker as a link
  (<sup><a href="#fn-N" id="fnref-N">N</a></sup>) and the footnote body at the foot of its
  section or the document, with a back-reference (<a href="#fnref-N">↩</a>). Preserve the
  original numbering: use the number the page shows, even if another page also starts at 1.
  Ids only have to be unique within YOUR page — where two pages reuse one, they are made
  unique across the document when the pages are joined. A marker whose body is on a later
  page (endnotes) should still link to it, and should be noted in the "log" field. A marker the
  page sets as a symbol (*, †, ‡, §) keeps that symbol as its visible text, because that is what
  the page shows — but a symbol on its own is punctuation to a screen reader, read as "star" or
  skipped entirely, so name the link: <sup><a href="#fn-1" id="fnref-1" aria-label="Footnote
  1">*</a></sup>, or with the meaning the page's own key gives that symbol where it gives one. A
  symbol has no number to build an id from, so number symbol markers by the order they appear on
  the page — and never hand one an id that a numbered footnote on this page already uses. Ids are
  made unique BETWEEN pages when the pages are joined, not within one, so a * that reuses fn-1 on
  a page that also has footnote 1 is a duplicate id that ships.
- QUOTATIONS: <blockquote> for a block quotation, <q> only for a short inline one. Attribute a
  visible source with <cite>. Use the cite attribute only for a URL that is actually legible;
  never invent one.
- ORDERED LISTS: when the numbering does not begin at 1, set start on the <ol> so the numbers
  match the source. Use <ul>/<ol>/<dl> for real lists, never dashes or manual numbering in
  paragraphs.
- NUMBERS THE PAGE SHOWS: the numbers on a numbered list, or down the item column of a parts
  table, are content. Transcribe the sequence exactly and never tidy it: do not renumber to close
  a gap, and do not drop or alter a number that appears twice — a table that reads 1, 2, 5, 5, 6
  reads 1, 2, 5, 5, 6 here. In a table those numbers are cell text, so transcribing them is enough;
  in a numbered list they are not text at all, because an <ol> counts 1, 2, 3 by itself whatever you
  put in it — so set value on any <li> whose number differs from the count (<li value="5">), the way
  start carries a list that does not begin at 1. Where the sequence skips or repeats, say so once in
  a <p> immediately after that list or table, give that <p> an id and point the table's or list's
  aria-describedby at it, so the note reaches a reader who arrives by moving from table to table
  rather than by reading every line. Number those ids by the order the annotated lists and tables
  appear on the page — numbering-note-1, numbering-note-2 — and never reuse one: a page whose two
  notes both take id="note" ships a duplicate id, since ids are made unique between pages at the
  join and not within one. Keep what you write to what this page shows: "Items 3 and 4 are
  not listed in this table" is something a reader can check against the rows above it, while "items
  3 and 4 do not appear in this assembly" is a claim about a document you were not shown — the
  missing numbers may be listed on another page, or left unlisted on purpose. Do this for
  EVERY irregular list and table on the page, and record each one in the "log" field as well: a
  skip in the first table counts exactly as much as one in the last, and annotating only the last
  tells a reader that the others were checked and found sound. Never write such a note for a
  sequence that is in fact unbroken, and where the page prints its own note about the numbering,
  transcribe that rather than adding a second one beside it.
- ABBREVIATIONS AND KEYS: where the page itself says what a short form means — a legend under a
  table, a key beside a diagram, a footnote, a parenthetical on first use — carry that meaning
  into the markup in the page's own words: <abbr title="not shown">NS</abbr>. Never supply an
  expansion the page does not state, however obvious it looks. Encode it ONCE, where the page
  keeps it: transcribe the legend or key as the structure it is (a <dl> of symbol and meaning, or
  the footnote it is written as) and do NOT also put a paragraph above the table restating what
  the legend below it already says — read in order, that is the same sentence twice, and the
  second copy is prose you wrote rather than content the page has. Inside a table, mark every
  cell that carries the abbreviation and not only the first: a row is read on its own, so an
  <abbr> in row 1 does nothing for someone who lands on row 20. In running prose the first
  occurrence is enough.
- SIGNATURE AND FILL-IN BLOCKS: a block of fields the page provides for someone to complete — a
  signature block, an application section, a run of fill-in lines — is a form even where it has
  already been filled in. Render the whole block as a <form> with one <fieldset>/<legend> per
  signing party or logical group, and every field in it (Signature, Printed Name, Title, Date)
  as an <input> with its own <label>. Transcribe a field that is already filled in as
  <input readonly value="..."> rather than as a <dd> or as plain text, so that every party in
  one block has the same structure: one party as a <dl> and another as controls tells a
  screen-reader user the two differ in kind, when the only difference is that one is filled in.
  Associate a handwritten-signature image with its field using aria-describedby. Set
  aria-required="true" only where the page itself marks a field as required, never merely
  because it is blank. This is about fields, not about every label/value pair: printed metadata
  nobody is meant to complete (a reference number, a "Prepared by" line) is still a <dl>.
- PAGE-BREAK MARKERS: where you mark the boundary of the page you were given, the marker carries
  the page number the page prints as its text content, and carries no aria-label and no
  aria-labelledby: <p role="doc-pagebreak" id="page-5">5</p>. The id is what a reference to this
  page needs and the text is what names the marker, so there is nothing left for a label to do —
  and role="doc-pagebreak" is named by its own contents, which makes a name supplied as an
  attribute prohibited on it rather than merely redundant. That distinction is the whole of this
  rule: the same marker written <p role="doc-pagebreak" aria-label="Page 5" id="page-5"></p> is a
  SERIOUS violation, because the prohibition only bites when the element is empty — put the number
  inside and the name comes from content and the attribute goes unremarked, so a document can carry
  that label on six markers that kept their number and fail the gate on the seventh that lost it.
  Never emit an empty marker in any form: a role with nothing in it announces a boundary to a
  screen-reader user and then says nothing about which boundary it is. Where the page prints no
  number you can read, leave the marker out and note the boundary in the "log" field instead. The
  same holds wherever you reach for a name: aria-label belongs on an element whose role takes one —
  a link, a button, a table, a region — never on a <p>, <span> or <div> that is only holding text.

If — and only if — this page contains a content type that a DEDICATED specialist agent would
handle clearly better than this general pass (something beyond the common types: paragraph,
heading, list, table, form field, image, quote, caption, footnote), include a
"suggested_agent". Suggest sparingly; omit it (or null) otherwise.

Respond with ONLY this JSON:
{ "html": "<accessible HTML for the whole page — body content only, no duplication>",
  "log": "notes, e.g. content cut off at an edge",
  "suggested_agent": { "name": "lowerCamelCase", "reason": "why a specialist is warranted" } }`;

export interface ExtractionResult {
  fragments: Fragment[];
  suggestions: { name: string; reason: string; image: string }[];
  // Source pages (1-based order) the delivered document has NO content for: their own
  // extraction threw and they are in the document as a failure marker — see
  // `failedPage`. Empty on an ordinary run. Returned rather than only logged because a
  // document delivered with a page missing is a different deliverable, and the caller
  // records it alongside the run's other outcome counts.
  //
  // From `reExtractPages` this is the set the document ALREADY had, minus any page the
  // re-extraction filled in. A re-extraction that throws does not add to it: that path
  // only runs for pages which already have a fragment, so the page keeps the content it
  // had and the document is no less whole than it was. Those are reported as
  // `reextract_complete.failed` instead — folding them in would tell a client its
  // document is missing a page that is in it.
  failedPages: number[];
  // Pages that WERE in `failedPages` and are not any more, because this re-extraction
  // produced content for them. Returned rather than logged here: "the document has this
  // page now" only becomes true once the round's document is persisted, and a round that
  // throws after re-extracting (in the Reader, the editor, the lint) leaves the client
  // holding the document that still has the hole. Logged by the caller, after the write
  // (pipeline/orchestrator.ts) — diagnostics folds the event straight into
  // `pages_failed`, so a premature line there claims a document is whole when it is not.
  recovered?: number[];
}

function stripFences(t: string): string {
  const m = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (m ? m[1] : t).trim();
}

// Load the page agent, preferring a session-built/trained copy (tmp/), then the
// committed agents/page.md, and finally the built-in default. Whatever is loaded
// is also what build-time verification and feedback-driven training operate on.
function loadPageAgent(ctx: PipelineContext): AgentSpec {
  const loaded = loadAgent(PAGE_AGENT, {
    agentsDir: ctx.paths.agentsDir,
    tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
  });
  if (loaded) return loaded;
  return {
    name: PAGE_AGENT,
    file: "page.md",
    content: DEFAULT_PAGE_PROMPT,
    capabilities: ["vision"],
    sha: null,
    sessionBuilt: false,
  };
}

interface PageRender {
  html: string;
  log: string;
  suggestion?: { name: string; reason: string };
}

// Everything the page agent is told that is NOT about the page in front of it: its own
// prompt, the accessibility contract, and whatever this deployment has learned from
// past corrections. One function, used by every page-agent call, so all of them send
// one byte-identical prefix — which is the condition a cache breakpoint needs to hit
// (providers/promptCache.ts). On a 25-page document that is one cache write and two
// dozen reads at a tenth of the price, on the largest single line in the bill: `page`
// was 779,855 input tokens of the 1.48M measured in issue #136.
//
// The requirements moved here from the user message, where they were re-sent per page
// after the "convert this page" line. That is where the accessibility.ts comment says
// they belong anyway ("appended to each content-agent system prompt", which is how
// `runSpecialist` has always used them) — and being instructions that hold for every
// page, they were never page-specific text. Same for the lessons. What stays in the
// user message is what actually differs per call: the filename and page number, that
// page's link targets, the user's feedback, and the page's previous output.
function pageSystem(agent: AgentSpec, lessons: string): string {
  return `${agent.content}\n\n${ACCESSIBILITY_REQUIREMENTS}${lessons}`;
}

async function renderPage(
  ctx: PipelineContext,
  agent: AgentSpec,
  img: InputImage,
  lessons: string,
  // On a feedback re-extraction, the HTML this page produced last time. Shown so
  // the agent corrects what the feedback names and carries everything else over,
  // rather than re-deriving the page from scratch and drifting elsewhere.
  previous?: string,
): Promise<PageRender> {
  const priorSection = previous
    ? `\n\n## Your previous output for this page\n\`\`\`html\n${previous}\n\`\`\`\n` +
      `Apply the user feedback above to this page. Keep everything the feedback does NOT ` +
      `concern exactly as it was, and re-check the affected content against the source image.\n`
    : "";
  // The page's own link targets, which the image cannot show (pipeline/links.ts).
  const links = pageLinkContext(img.links);
  if (links.shown.length) {
    ctx.log.event("page_links", { image: img.name, links: links.shown.length, dropped: links.dropped });
  }
  const user =
    `Convert this document page image (filename: ${img.name}, page ${img.order} of ${ctx.images.length}) ` +
    `to accessible HTML.${links.section}${feedbackPreamble(ctx)}${priorSection}`;
  const res = await ctx.router.complete(
    PAGE_AGENT,
    "vision",
    [
      { role: "system", content: pageSystem(agent, lessons) },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ html?: string; log?: string; suggested_agent?: { name?: string; reason?: string } }>(res.text);
  const sa = parsed?.suggested_agent;
  return {
    html: parsed?.html ?? stripFences(res.text),
    log: parsed?.log ?? "",
    suggestion: sa?.name ? { name: sa.name, reason: sa.reason ?? "" } : undefined,
  };
}

// Re-run the page agent with the fidelity problems it was told about, so it can
// fix them against the source image. Used only when verification fails.
async function correctPage(
  ctx: PipelineContext,
  agent: AgentSpec,
  img: InputImage,
  previous: string,
  problems: string[],
  lessons: string,
): Promise<string | null> {
  // The link list is repeated here, not just in the first pass: a dropped link is one
  // of the problems this pass exists to fix, and it cannot re-attach a URL it can no
  // longer see. The image still does not show them.
  const user =
    `Your previous accessible-HTML output for this page had fidelity/accessibility problems:\n` +
    `${problems.map((p) => `- ${p}`).join("\n")}\n\n` +
    `## Your previous output\n\`\`\`html\n${previous}\n\`\`\`\n\n` +
    `Look at the source image again and return a corrected version that resolves every problem.` +
    `${pageLinkContext(img.links).section}`;
  const res = await ctx.router.complete(
    PAGE_AGENT,
    "vision",
    [
      // The same prefix the first pass sent, down to the byte, so this call reads the
      // cache the first one wrote instead of paying for a near-copy of it. It also
      // gains the lessons, which this pass never had: a correction that re-derives the
      // page without them can undo the very thing a past correction taught.
      { role: "system", content: pageSystem(agent, lessons) },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ html?: string }>(res.text);
  const corrected = (parsed?.html ?? stripFences(res.text)).trim();
  return corrected || null;
}

// Merge instruction for splicing a specialist fragment into the page output.
const MERGE_SYSTEM = `You merge a higher-fidelity HTML fragment, produced by a specialist agent, into an
existing accessible HTML page. Replace the page's weaker representation of that SAME content
with the specialist fragment and change nothing else — keep all other content, order,
headings, and structure exactly, and never leave both representations (no duplication).
Output body content only (no <html>/<head>/<body> wrapper).
Respond with ONLY this JSON: { "html": "<merged body content>" }`;

// Run a library specialist agent against the whole page image, asking it to
// extract only the content its contract covers. Returns its HTML fragment, or
// null when it finds nothing.
async function runSpecialist(ctx: PipelineContext, agent: AgentSpec, img: InputImage): Promise<string | null> {
  const system = `${agent.content}\n\n${ACCESSIBILITY_REQUIREMENTS}`;
  const user =
    `Extract ONLY the content your contract covers from this page image (filename: ${img.name}). ` +
    `If none is present, return {"no_content": true}. Otherwise respond with ONLY this JSON: ` +
    `{ "no_content": false, "html": "<your accessible HTML fragment>" }`;
  const capability = agent.capabilities.includes("vision") ? "vision" : "text";
  const res = await ctx.router.complete(
    agent.name,
    capability,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent, phase: "extraction", image: img.name, output: res.text });
  const parsed = extractJson<{ no_content?: boolean; html?: string }>(res.text);
  if (!parsed || parsed.no_content || !parsed.html?.trim()) return null;
  return parsed.html.trim();
}

// Splice a specialist fragment into the page body, replacing the page's own
// (weaker) representation of that content. Returns the merged body, or null on
// failure (caller keeps the original page output).
async function mergeSpecialist(
  ctx: PipelineContext,
  img: InputImage,
  pageHtml: string,
  specialistName: string,
  reason: string,
  fragment: string,
): Promise<string | null> {
  const user =
    `## Current page (body HTML)\n\`\`\`html\n${pageHtml}\n\`\`\`\n\n` +
    `## Specialist (${specialistName}) fragment for the ${reason || "flagged"} content on this page\n` +
    `\`\`\`html\n${fragment}\n\`\`\`\n\n` +
    `Replace the page's existing representation of that content with this specialist fragment; ` +
    `keep everything else unchanged.`;
  const res = await ctx.router.complete(PAGE_AGENT, "text", [
    { role: "system", content: MERGE_SYSTEM },
    { role: "user", content: user },
  ]);
  ctx.log.agentCall({
    agent: { name: PAGE_AGENT, file: "page.md", content: MERGE_SYSTEM, capabilities: ["text"], sha: null, sessionBuilt: false },
    phase: "extraction",
    image: img.name,
    output: res.text,
  });
  const parsed = extractJson<{ html?: string }>(res.text);
  return parsed?.html?.trim() || null;
}

// The agent names a suggestion could have resolved to, for the
// `specialist_unresolved` log line. Session-built agents (tmp/) are included
// because loadAgent prefers them, so they are genuinely dispatchable. Sorted so
// two runs of the same library produce comparable log lines. Best-effort: this
// exists to explain a miss, so it must never turn one into a failed run.
//
// `page` and `feedback` are excluded because they are the pipeline's own agents,
// not content types anything should route to.
//
// Standard-type names are NOT in here, even though they are the commonest
// near-miss. They are reported alongside, under `declined_types` (see
// `unresolvedCandidates`), because the two answer different questions and merging
// them makes the answer to the first one false: `candidates` reads as "what I could
// have asked for", and a standard type is not that — it is declined by policy
// before the file is ever looked up, and since §7.4 v1.2 there is no file either.
function libraryAgentNames(ctx: PipelineContext): string[] {
  const names = new Set<string>();
  for (const dir of [ctx.paths.agentsDir, ctx.paths.tmpAgentsDir(ctx.sessionId)]) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // tmp/ may not exist yet, or agents_dir may be misconfigured
    }
    for (const f of entries) {
      if (!f.endsWith(".md")) continue;
      const logical = f.slice(0, -3);
      if (logical === PAGE_AGENT || logical === "feedback") continue;
      names.add(logical);
    }
  }
  return [...names].sort();
}

// The two lists a `specialist_unresolved` line needs, kept apart on purpose.
//
// `candidates` is what WAS dispatchable — real files, so a near-miss against one of
// them ("chart" for `chartDataAgent`) is readable as a near-miss rather than needing
// a second run to investigate.
//
// `declined_types` is the other half of the explanation, and the commonest one: the
// most frequent near-miss is a plural or variant of a standard type. A suggestion of
// "tables" is not in STANDARD_AGENTS, so it never reaches the decline branch, and it
// resolves to no file — so it lands in the unresolved branch, where omitting "table"
// hides the whole reason. Naming these separately says what is true of them: had the
// model written "table", it would have been declined, not dispatched. Reporting them
// as `candidates` would claim the opposite.
function unresolvedCandidates(ctx: PipelineContext): { candidates: string[]; declined_types: string[] } {
  return { candidates: libraryAgentNames(ctx), declined_types: [...STANDARD_AGENTS].sort() };
}

// If a page flagged a content type that an EXISTING library agent handles, run
// that specialist on the page and merge its higher-fidelity fragment into the
// page output. Non-blocking: any failure leaves the page output unchanged.
// dispatched=true means a library specialist ran (so the suggestion is already
// covered and should not be re-filed as a new-agent issue).
async function dispatchSpecialist(
  ctx: PipelineContext,
  img: InputImage,
  pageHtml: string,
  suggestion: { name: string; reason: string },
): Promise<{ html: string; dispatched: boolean }> {
  // Normalized by the shared `logicalType`, and tested for standardness by the shared
  // `isStandardType`, so this site and `runContribution` cannot disagree about what a
  // name means. They did once: trim-then-strip versus strip-then-trim differed on
  // `"table.md "`, which slipped past one filter and not the other.
  //
  // The decline below is keyed on the STANDARD list rather than on what is on disk,
  // because a deployment that drops a `table.md` into `agents/` must not get the
  // original bug back: a standard specialist splicing its fragment over content the
  // general page pass already rendered, which is the two-representations-of-one-thing
  // duplication the page prompt forbids. The two outcomes also differ observably — a
  // `specialist_unresolved` line blaming the name versus a `specialist_declined` line
  // stating the policy — and the decline is the true one.
  const logical = logicalType(suggestion.name);
  // Every path out of here is logged, including the ones that do nothing.
  // `logical` is free text the model wrote, resolved to a file by name, so a
  // specialist silently fails to run whenever the model's wording and the
  // library's filenames disagree — `chart` for `chartDataAgent.md`, a display
  // name, a plural. Without a log line for the miss, "routing was never
  // attempted" and "routing was attempted and the name did not resolve" are the
  // same observation: a page that came out of the general pass. `candidates`
  // names what WAS available, so a miss can be read as a near-miss rather than
  // needing a second run to investigate.
  //
  // `agent` carries the same meaning on every branch, so one filter on
  // `type=="specialist_unresolved"` can read `.agent` regardless of which branch
  // produced it. The empty-name case reports the raw string it could not use.
  if (!logical) {
    ctx.log.event("specialist_unresolved", {
      agent: suggestion.name,
      image: img.name,
      reason: "empty name",
      ...unresolvedCandidates(ctx),
    });
    return { html: pageHtml, dispatched: false };
  }
  if (isStandardType(logical)) {
    // Not a failure: the general page pass already covers the standard types, so
    // this suggestion is correctly declined. Logged to keep the counts of
    // suggested / declined / dispatched / unresolved reconcilable from one run.
    //
    // Case-insensitive, so `"Table"` declines here rather than falling through to a
    // file lookup — which on a case-insensitive volume would find `agents/table.md` if
    // a deployment added one, and dispatch the very specialist this rule forbids. The
    // name is logged as the model wrote it, since that is what a maintainer reading the
    // log has to recognize.
    ctx.log.event("specialist_declined", { agent: logical, image: img.name, reason: "standard type" });
    return { html: pageHtml, dispatched: false };
  }
  const specialist = loadAgent(logical, {
    agentsDir: ctx.paths.agentsDir,
    tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
  });
  if (!specialist) {
    ctx.log.event("specialist_unresolved", {
      agent: logical,
      image: img.name,
      reason: "no agent file of that name",
      ...unresolvedCandidates(ctx),
    });
    return { html: pageHtml, dispatched: false };
  }
  try {
    const fragment = await runSpecialist(ctx, specialist, img);
    if (!fragment) {
      ctx.log.event("specialist_no_content", { agent: specialist.file, image: img.name });
      return { html: pageHtml, dispatched: true };
    }
    const merged = await mergeSpecialist(ctx, img, pageHtml, specialist.name, suggestion.reason, fragment);
    ctx.log.event("specialist_dispatched", { agent: specialist.file, image: img.name, merged: Boolean(merged) });
    return { html: merged ?? pageHtml, dispatched: true };
  } catch (e) {
    ctx.log.event("specialist_dispatch_failed", { agent: specialist.file, image: img.name, error: (e as Error).message });
    return { html: pageHtml, dispatched: true };
  }
}

interface PageOutcome {
  fragment: Fragment;
  // A genuinely-new content type to file for contribution, if any. A suggestion
  // already covered by a dispatched library specialist is not reported.
  suggestion?: { name: string; reason: string; image: string };
  // Set when this page's own extraction threw and the fragment is a stand-in rather
  // than the page's content (`failedPage`). Carried explicitly rather than inferred
  // from the fragment, because a caller must not have to pattern-match HTML to find
  // out whether the document it was handed is whole.
  failed?: true;
  // The error that page threw, kept so it can be re-raised if it turns out EVERY page
  // failed (see runExtraction). Containment replaces one message with a document; when
  // there is no document, the message is all there is, and a fresh one written here
  // would be a worse diagnosis than the provider's own.
  error?: unknown;
}

// What one page leaves behind when its own extraction throws.
//
// Everything else in this file already degrades a PAGE rather than a document: a
// specialist that fails is logged and the page is kept as the general pass wrote it
// (`dispatchSpecialist`), a fidelity check that cannot run counts as nothing to
// correct (`failedCheck`), a correction that comes back empty is discarded. Only the
// page's own render was fatal to the whole run — so a model call that hit the output
// ceiling on page 26 of 50 threw away 24 pages that had already been rendered,
// verified and corrected, and delivered nothing (issue #135). "This page's output is
// unusable" and "this document is unrecoverable" are different claims, and the caller
// is better placed than this function to decide whether 24 good pages are acceptable.
//
// The page is NOT silently dropped. An empty fragment is filtered out at assembly, so
// the delivered document would simply be missing a page with nothing to say so — and
// a page absent for a reason nobody recorded is the failure this function exists to
// avoid re-creating one level down. The marker is a comment because the alternative is
// worse: a visible note is prose Iris wrote into a document whose whole contract is
// that every word in it is a word on the page. A comment is invisible to a reader,
// inert to axe and to `flatten`, and findable by tooling — the same trade
// `wrapDocument` makes for @unresolved, and it sanitizes runs of dashes for the same
// reason (a `--` inside a comment ends it early).
function failedPage(ctx: PipelineContext, pageAgent: AgentSpec, img: InputImage, e: unknown): PageOutcome {
  const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
  ctx.log.event("page_extraction_failed", { image: img.name, page: img.order, error: message });
  const note = message.slice(0, 300).replace(/--+/g, "—");
  return {
    fragment: {
      image: img.name,
      order: img.order,
      agent: pageAgent.file,
      region: "page",
      innerHtml: `<!-- @page-failed ${img.order}: ${note} -->`,
      edges: [],
      log: `extraction failed: ${message}`,
    },
    failed: true,
    error: e,
  };
}

// Did the fidelity check actually find something? `verifyAgentOutput` is deliberately
// non-blocking: it answers ok=false with an empty problem list when the check could
// not be made at all (no Feedback Agent configured, an unusable reply). That has
// always counted as "nothing to correct", and both uses below depend on it meaning the
// same thing — one to decide whether to correct, the other to decide whether a
// correction may replace a fragment that had passed.
function failedCheck(verdict: VerifyVerdict): boolean {
  return !verdict.ok && verdict.problems.length > 0;
}

// Everything one page needs: render -> optional specialist merge -> verify ->
// optional self-correction. Pages share no mutable state, so this is safe to run
// concurrently for several pages at once (see runExtraction).
async function extractPage(
  ctx: PipelineContext,
  pageAgent: AgentSpec,
  img: InputImage,
  lessons: string,
  sampler: RecheckSampler,
  previous?: string,
): Promise<PageOutcome> {
  const { html, log, suggestion } = await renderPage(ctx, pageAgent, img, lessons, previous);
  let innerHtml = html;
  let logNote = log;
  let dispatched = false;

  // Specialist dispatch: if the page flagged a content type that an existing
  // library agent handles (e.g. a chart), run that agent and merge its
  // higher-fidelity fragment into the page BEFORE the fidelity check.
  if (suggestion?.name) {
    const result = await dispatchSpecialist(ctx, img, innerHtml, suggestion);
    dispatched = result.dispatched;
    if (result.html !== innerHtml) {
      innerHtml = result.html;
      logNote = logNote ? `${logNote}; merged ${suggestion.name}` : `merged ${suggestion.name}`;
    }
  }

  const verdict = await verifyAgentOutput(ctx, pageAgent, img, [{ html: innerHtml }]);

  // Whether the page's links arrived is checked here rather than left to the
  // Feedback Agent: it verifies the output against the IMAGE, which is the one place
  // a link target does not appear, so a dropped link is invisible to it and a
  // fabricated one unfalsifiable. The comparison against the file's own annotations
  // is exact, so it is made in code and handed to the same self-correction pass as
  // any other fidelity problem.
  const missing = missingLinks(img.links, innerHtml);
  if (missing.length) {
    ctx.log.event("page_links_missing", { image: img.name, links: missing.map((l) => l.href) });
  }

  // page_verify_ok / page_verify_failed report the Feedback Agent's verdict and
  // nothing else, exactly as they did before links existed — a missing link is not
  // part of that verdict, and folding it in would make the two events mean different
  // things in old logs and new ones. `page_links_missing` above is the signal for a
  // correction driven by a link.
  const verifyFailed = failedCheck(verdict);
  if (verifyFailed) {
    ctx.log.event("page_verify_failed", { image: img.name, problems: verdict.problems });
  } else {
    ctx.log.event("page_verify_ok", { image: img.name });
  }

  const problems = [
    ...(verifyFailed ? verdict.problems : []),
    ...missing.map(missingLinkProblem),
  ];
  if (problems.length) {
    // What the correction was asked to fix, for the event below. Both triggers can fire
    // on one page, and they cost the same call but mean different things: a link the
    // model dropped is an exact, code-checked miss, while a fidelity problem is the
    // Feedback Agent's judgement.
    const trigger = verifyFailed ? (missing.length ? "both" : "verify") : "links";
    const before = innerHtml.trim();
    const corrected = await correctPage(ctx, pageAgent, img, innerHtml, problems, lessons);
    // What the pass changed, measured but NOT used to decide what ships. Whether the
    // fragment is adopted stays on string identity, exactly as it was before any of this:
    // `correctionEffect` observes the text, the descriptions, the attributes and the tag
    // sequence, and a delivery decision must not turn on a signal being complete — a
    // correction whose only change is one this cannot see would be silently reverted, and
    // the page would keep the defect the pass had already fixed. The effect decides the
    // LABEL, which is all the note it answers asked for: a model that re-indents its own
    // page, or writes `&` where it wrote `&amp;`, returns a different string and the same
    // page, and counting that under `results.kept` beside a restored table row is what makes
    // the number unreadable — `text` and `structure` overlap, so the fold cannot subtract it
    // out afterwards.
    const effect = corrected ? correctionEffect(before, corrected) : null;
    const moved = effect !== null && changedAnything(effect);
    // A correction that produced nothing usable, or produced the page it was given back, is
    // a page call paid for and nothing delivered. Recorded because it was previously
    // invisible: the log said a page failed its check and said nothing about what the
    // pass bought, so the loop's value could only be guessed at from call counts (issue
    // #137). See `correctionEffect` for why the kept case reports what it changed.
    if (!corrected || corrected === before) {
      ctx.log.event("page_corrected", {
        image: img.name,
        page: img.order,
        trigger,
        problems: problems.length,
        result: corrected ? "identical" : "empty",
      });
    }
    if (corrected && corrected !== before) {
      // A page that PASSED its fidelity check is being re-rendered here only to
      // recover a link, so the rewrite has to earn the standing the original already
      // had: it is verified in turn, and a rewrite that lost something is discarded
      // in favour of the fragment that was known to be good. A link is additive, and
      // paying for it with the structure of a page that already checked out — a
      // heading level, a `<th scope>` — would make the document worse than it was
      // before this feature. When the check had already failed, the original has no
      // standing to protect and the correction is accepted as it always was.
      let keep = true;
      let recheck: VerifyVerdict | null = null;
      if (!verifyFailed) {
        recheck = await verifyAgentOutput(ctx, pageAgent, img, [{ html: corrected }]);
        keep = !failedCheck(recheck);
        if (!keep) {
          ctx.log.event("page_links_correction_rejected", {
            image: img.name,
            links: missing.map((l) => l.href),
            problems: recheck.problems,
          });
        }
      } else if (moved && claimRecheck(sampler)) {
        // Measurement only, on at most one page per batch: does a corrected page pass
        // the check it just failed? A page the pass did not actually change is not worth
        // the batch's one slot — there is nothing to check, and the answer would be the
        // verdict already on record. Nothing here decides anything — a verify-driven
        // correction is accepted exactly as it always was, whatever this says — because
        // whether to keep re-rendering until a page passes is a policy question, and the
        // answer to it needs the rate this event exists to produce (issue #137). See
        // `RECHECKS_PER_BATCH` for why it is one page and not all of them.
        //
        // And nothing here can cost a page either. `verifyAgentOutput` is non-blocking
        // for an absent Feedback Agent and an unparseable reply, but a PROVIDER error is
        // rethrown (providers/index.ts logs `model_call ok:false` and throws), so an
        // uncaught throttle on this one extra call would propagate out of extractPage
        // into `failedPage` and ship a `@page-failed` marker for a page that had already
        // rendered, verified and corrected — the corrected fragment sitting in a local
        // variable and thrown away. A measurement that decides nothing must not be able
        // to delete a page of accessible content, so a failed sample is a sample not
        // taken: it is logged, the slot stays spent (a refund would let a throttled
        // provider be retried once per corrected page, which is the cost this bounds),
        // and the page ships exactly as it would have with no measurement at all.
        recheck = await verifyAgentOutput(ctx, pageAgent, img, [{ html: corrected }]).catch(
          (e: unknown) => {
            ctx.log.event("page_correction_recheck_failed", {
              image: img.name,
              page: img.order,
              error: (e as Error).message,
            });
            return null;
          },
        );
      }
      if (recheck) {
        // `ok` is "the verifier named no problem", which is also what an unavailable
        // Feedback Agent looks like (see `failedCheck`). On this branch the sampled
        // recheck can only follow a verdict it gave, so the ambiguity is confined to the
        // links path, where it was already the standing behaviour.
        ctx.log.event("page_correction_recheck", {
          image: img.name,
          page: img.order,
          ok: !failedCheck(recheck),
          problems: recheck.problems,
          // Whether this verdict was allowed to change what is delivered. False for the
          // sample, so a consumer cannot read it as the loop having gained a gate.
          binding: !verifyFailed,
        });
      }
      // What the pass actually changed about the page, and whether that change is what
      // the document carries. `correctionEffect` reads both fragments rather than the
      // verdict, so "the alt text was refined" and "a table came back" are separable in
      // a log where both were `page_verify_failed` — which is the measurement issue #137
      // asks for and the one the verdict cannot give about itself.
      //
      // `kept` is reserved for a correction that changed something, so a fragment adopted
      // because it differs as a string while being the same page is `identical` here: the
      // page call was paid for and bought nothing, whichever of the two strings ships.
      ctx.log.event("page_corrected", {
        image: img.name,
        page: img.order,
        trigger,
        problems: problems.length,
        result: keep ? (moved ? "kept" : "identical") : "rejected",
        ...effect,
      });
      if (keep) {
        innerHtml = corrected;
        logNote = logNote
          ? `${logNote}; self-corrected after fidelity check`
          : "self-corrected after fidelity check";
        // Whether the correction actually re-attached them is worth recording: the pass
        // is single-shot, so a link still missing here is missing from the delivered
        // document, and that is the whole failure this feature has to be able to see.
        const stillMissing = missingLinks(img.links, innerHtml);
        if (stillMissing.length) {
          ctx.log.event("page_links_unrecovered", { image: img.name, links: stillMissing.map((l) => l.href) });
        }
      }
    }
  }

  // Checked last, on the fragment that is actually delivered: a correction pass
  // re-writes the anchors, so an href invented there is the one worth seeing.
  // Logged, not corrected — a visible URL linked to itself is legitimate. See
  // `unexpectedHrefs` for why the list is worth having anyway.
  const unexpected = unexpectedHrefs(img.links, innerHtml);
  if (unexpected.length) {
    ctx.log.event("page_links_unexpected", { image: img.name, hrefs: unexpected });
  }

  return {
    fragment: {
      image: img.name,
      order: img.order,
      agent: pageAgent.file,
      region: "page",
      innerHtml,
      edges: [],
      log: logNote,
    },
    suggestion:
      suggestion?.name && !dispatched
        ? { name: suggestion.name, reason: suggestion.reason, image: img.name }
        : undefined,
  };
}

// One fragment per page, in submitted order. Each page is verified for source
// fidelity at build time (PRD §7.5/§7.12); a page that fails gets one self-
// correction pass. Verification is non-blocking — a run never fails because the
// Feedback Agent is unavailable or unsure. When a page flags a content type that an
// existing library agent handles, that specialist is dispatched and merged in;
// otherwise the suggestion is collected for the contribution step.
//
// Pages are extracted CONCURRENTLY (defaults.extraction_concurrency), which is
// the dominant latency term for a multi-page document: each page costs up to
// several sequential model calls, and pages are fully independent. Document order
// is preserved by mapWithConcurrency returning results in input order — never
// rely on completion order here.
export async function runExtraction(ctx: PipelineContext): Promise<ExtractionResult> {
  const pageAgent = loadPageAgent(ctx);
  // Inject corroborated lessons learned from past feedback into the page agent
  // prompt (#1), so it improves without rewriting agents/page.md.
  const lessons = examplesForPrompt(ctx.paths, pageAgent.file);
  if (lessons) ctx.log.event("page_lessons_injected", { chars: lessons.length });

  const limit = ctx.extractionConcurrency;
  ctx.log.event("extraction_start", { pages: ctx.images.length, concurrency: limit });

  // Contained per page: mapWithConcurrency rejects with the first error any item
  // throws (matching a serial loop), so without this one page takes the document with
  // it. See `failedPage`.
  // One measurement-only re-verify for the whole batch, claimed by whichever corrected
  // page gets there first (correction.ts). Created here rather than inside extractPage so
  // it cannot become one per page, which is the cost it exists to bound.
  const sampler = recheckSampler();
  const outcomes = await mapWithConcurrency(ctx.images, limit, (img) =>
    extractPage(ctx, pageAgent, img, lessons, sampler).catch((e) => failedPage(ctx, pageAgent, img, e)),
  );

  // Results come back in input order, so fragments are already in page order.
  const fragments = outcomes.map((o) => o.fragment);
  const suggestions = outcomes
    .map((o) => o.suggestion)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const failedPages = outcomes.filter((o) => o.failed).map((o) => o.fragment.order);
  // Always logged, including the zero case, so "no page failed" and "this run predates
  // per-page containment" are not the same observation in a log.
  ctx.log.event("extraction_complete", { pages: fragments.length, failed: failedPages });

  // Nothing was extracted. Containment trades a thrown run for the pages that DID
  // work, and with none of them there is nothing to trade: assembly and the review
  // loop would run happily on a body of failure markers (the Reader and Editor are
  // text calls, so whatever killed the page images need not touch them), and the
  // session would end `ready_for_review` serving a document containing none of the
  // source's words. That is worse than the failure it replaced, which at least named
  // the ceiling and the knob to raise (test/e2e.sh §9d).
  //
  // The FIRST page's error, unwrapped, because it is the diagnosis: a message written
  // here would say "every page failed" and drop the provider's account of why. The
  // remaining pages' errors are already in the log, one event each.
  if (outcomes.length > 0 && failedPages.length === outcomes.length) {
    ctx.log.event("extraction_failed", { pages: failedPages.length, reason: "no page produced content" });
    // The `??` is unreachable — `failed` is only ever set alongside `error` — but a
    // thrown `undefined` would reach the operator as the string "undefined", which is
    // the one outcome this branch exists to prevent.
    throw outcomes[0].error ?? new Error("extraction failed for every page");
  }

  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  return { fragments, suggestions, failedPages };
}

// Re-extract only the pages a piece of feedback actually concerns (PRD §7.12),
// leaving every other page's prior fragment untouched.
//
// This is the path for feedback the review loop structurally cannot serve: the
// Reader only ever sees the assembled HTML (by design, §7.8), so a misreading of
// the source raises no issue and the loop has nothing to act on. "You misread the
// table on page 3" can only be fixed by putting page 3's IMAGE back in front of
// the page agent. Each targeted page goes through the same
// render -> verify -> correct path as a first run, with its previous output shown
// so untouched content carries over.
//
// Returns fragments for the WHOLE document in page order — re-extracted pages
// replaced, the rest as they were.
export async function reExtractPages(
  ctx: PipelineContext,
  priorFragments: Fragment[],
  pages: number[],
  // Pages the document being refined has no content for, from the run that lost them.
  // Passed in because this function is the only thing that can shrink that set: a page
  // whose fragment is a failure marker still HAS a fragment, so it is re-extractable, and
  // a round that succeeds on it fills the hole. Anything else about the set is unchanged
  // by this path.
  priorFailedPages: number[] = [],
): Promise<ExtractionResult> {
  const targets = new Set(pages);
  const pageAgent = loadPageAgent(ctx);
  const lessons = examplesForPrompt(ctx.paths, pageAgent.file);
  if (lessons) ctx.log.event("page_lessons_injected", { chars: lessons.length });

  // Only re-extract a targeted page we still have BOTH the source image and a
  // prior fragment for.
  const priorByOrder = new Map(priorFragments.map((f) => [f.order, f]));
  const toRun = ctx.images.filter((img) => targets.has(img.order) && priorByOrder.has(img.order));
  const missing = [...targets].filter((p) => !toRun.some((img) => img.order === p));
  if (missing.length) ctx.log.event("reextract_skipped", { pages: missing, reason: "no source image or prior fragment" });

  ctx.log.event("reextract_start", {
    pages: toRun.map((i) => i.order),
    of: priorFragments.length,
    concurrency: ctx.extractionConcurrency,
  });

  // A page with no content has nothing worth showing the agent as "your previous
  // output": its fragment is the failure comment, and handing that back invites the
  // model to treat a note about a truncated response as prose to preserve — on the one
  // round whose whole job is to produce the page from scratch. So this page starts clean.
  const stillFailed = new Set(priorFailedPages);
  const previousFor = (order: number): string | undefined =>
    stillFailed.has(order) ? undefined : priorByOrder.get(order)?.innerHtml;

  // Contained per page as in runExtraction, but degrading to the PRIOR fragment rather
  // than to a failure marker: this path only runs for pages that already have one, and
  // a re-extraction that throws is a page Iris could not improve, not a page it lost.
  // Replacing good prior content with a marker would make a feedback round destructive.
  // A feedback round gets its own sample, for the same reason the first pass does: these
  // pages are corrected too, and a round that re-extracts three pages is as much a place
  // for the rate to come from as a full run.
  const sampler = recheckSampler();
  const outcomes = await mapWithConcurrency(toRun, ctx.extractionConcurrency, (img) =>
    extractPage(ctx, pageAgent, img, lessons, sampler, previousFor(img.order)).catch(
      (e): PageOutcome => {
        const message = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();
        ctx.log.event("page_extraction_failed", {
          image: img.name,
          page: img.order,
          error: message,
          kept: "prior",
        });
        return { fragment: priorByOrder.get(img.order)!, failed: true };
      },
    ),
  );

  const replaced = new Map(outcomes.map((o) => [o.fragment.order, o.fragment]));
  const fragments = [...priorFragments]
    .sort((a, b) => a.order - b.order)
    .map((f) => replaced.get(f.order) ?? f);
  const suggestions = outcomes
    .map((o) => o.suggestion)
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  // Pages left as they were because their re-extraction threw. NOT reported as
  // `failedPages`: that field means the document has no content for the page, and these
  // pages have their prior content — the document is whole, it is just not improved.
  // Conflating the two tells a client following docs/API.md §7c that it received a
  // partial document when it did not.
  const keptPrior = outcomes.filter((o) => o.failed).map((o) => o.fragment.order);
  // A page that WAS missing and re-extracted cleanly is no longer missing. One that was
  // missing and threw again keeps its marker, so it stays in the set.
  const filled = new Set(outcomes.filter((o) => !o.failed).map((o) => o.fragment.order));
  const failedPages = priorFailedPages.filter((p) => !filled.has(p));
  const recovered = priorFailedPages.filter((p) => filled.has(p));

  writeFileSync(
    join(ctx.paths.sessionFragments(ctx.sessionId), "fragments.json"),
    JSON.stringify(fragments, null, 2),
  );
  // `pages` is what was actually re-extracted, so a page that threw is not counted
  // among them — its entry in `replaced` is its own prior fragment, which is the
  // opposite of a page this run produced.
  ctx.log.event("reextract_complete", {
    pages: outcomes.filter((o) => !o.failed).map((o) => o.fragment.order).sort((a, b) => a - b),
    ...(keptPrior.length ? { failed: keptPrior } : {}),
  });
  return { fragments, suggestions, failedPages, recovered };
}
