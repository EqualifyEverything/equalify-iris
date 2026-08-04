import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { flatten } from "./flatten.ts";
import { knownPages, pageIndex } from "./pageindex.ts";
import { createAgentUpdateIssue, scopeHintFor } from "../github/issue.ts";
import { recordExample, type LessonKind } from "./memory.ts";
import type { FixtureCase } from "./regression.ts";

// Previously imported from github/contributions.ts, which was removed when the
// contribution model moved from close-time PRs to issues filed during the run.
// The feedback loop still records proposed library-agent updates in this shape
// (in agent-updates.md, gated by regression fixtures) for maintainer review.
export interface AgentUpdateContribution {
  agent_name: string; // e.g. "page.md"
  summary: string;
  diff_preview: string;
  content: string; // full updated agent file content
}

const FEEDBACK_AGENT = "feedback";

interface TrainOutput {
  changed?: boolean;
  summary?: string;
  agent_markdown?: string;
}

interface VerifyOutput {
  faithful?: boolean;
  accessible?: boolean;
  problems?: string[];
}

interface ClassifyOutput {
  kind?: string;
  instruction?: string;
  before?: string;
  after?: string;
}

export interface VerifyVerdict {
  ok: boolean;
  problems: string[];
}

function loadFeedbackAgent(ctx: PipelineContext): AgentSpec | null {
  return loadAgent(FEEDBACK_AGENT, {
    agentsDir: ctx.paths.agentsDir,
    tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
  });
}

function loadTargetAgent(ctx: PipelineContext, agentFile: string): AgentSpec | null {
  return loadAgent(agentFile, {
    agentsDir: ctx.paths.agentsDir,
    tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId),
  });
}

// A naive line-level diff (added/removed lines) for the update PR body and as the
// "correction" context handed to the Feedback Agent. Not a true minimal diff —
// just enough to show what changed.
function diffPreview(before: string, after: string, maxLines = 80): string {
  const a = new Set(before.split("\n"));
  const b = new Set(after.split("\n"));
  const removed = before.split("\n").filter((l) => !b.has(l)).map((l) => `- ${l}`);
  const added = after.split("\n").filter((l) => !a.has(l)).map((l) => `+ ${l}`);
  const lines = [...removed, ...added];
  return (
    lines.slice(0, maxLines).join("\n") +
    (lines.length > maxLines ? `\n… (${lines.length - maxLines} more changed lines)` : "")
  );
}

// ---------------------------------------------------------------------------
// Build-time verification (source-fidelity, PRD §7.5/§7.12)
// ---------------------------------------------------------------------------

// Ask the Feedback Agent (VERIFY task) whether an agent's output faithfully and
// accessibly captures its source image. In the single-pass pipeline this verifies
// the page agent's per-page output; it is also reused by the regression gate.
// Non-blocking: returns ok=true when the Feedback Agent is unavailable or returns
// nothing, so verification never breaks a run.
export async function verifyAgentOutput(
  ctx: PipelineContext,
  agent: AgentSpec,
  img: InputImage,
  blocks: { html: string }[],
): Promise<VerifyVerdict> {
  const fb = loadFeedbackAgent(ctx);
  if (!fb || blocks.length === 0) return { ok: true, problems: [] };

  const html = blocks.map((b) => b.html).join("\n\n");
  const user =
    `TASK: verify\n\n` +
    `## Agent under test: ${agent.file}\n\`\`\`markdown\n${agent.content}\n\`\`\`\n\n` +
    `## The agent's output for source image "${img.name}"\n\`\`\`html\n${html}\n\`\`\`\n\n` +
    `Compare the output against the attached source image.`;

  const res = await ctx.router.complete(
    FEEDBACK_AGENT,
    "vision",
    [
      { role: "system", content: fb.content },
      { role: "user", content: user },
    ],
    { images: [loadImage(img)] },
  );
  ctx.log.agentCall({ agent: fb, phase: "extraction", image: img.name, output: res.text });

  const parsed = extractJson<VerifyOutput>(res.text);
  if (!parsed) return { ok: true, problems: [] };
  const ok = parsed.faithful !== false && parsed.accessible !== false;
  return { ok, problems: parsed.problems ?? [] };
}

// ---------------------------------------------------------------------------
// Feedback routing (PRD §7.12): does this feedback need the source images?
// ---------------------------------------------------------------------------

export interface FeedbackScope {
  target: "extraction" | "document";
  // 1-based page orders to re-extract. Only meaningful when target is
  // "extraction"; empty means "source-level, but we could not localize it".
  pages: number[];
  reason: string;
}

// A feedback message that supposedly targets more than this share of a document's
// pages is treated as document-level: re-extracting nearly everything costs about
// as much as a fresh run and is rarely what a targeted correction means.
const MAX_REEXTRACT_FRACTION = 0.5;

// Ask the Feedback Agent (SCOPE task) whether feedback is about what was read off
// the source pages — which the review loop CANNOT fix, because the Reader only ever
// sees the assembled HTML (by design, §7.8) and so raises no issue for a misreading
// it cannot detect — or about the assembled document.
//
// Non-blocking and biased toward the cheap path: any doubt (agent unavailable,
// unparseable answer, no pages identified) resolves to "document", which is the
// pre-existing behavior. A wrong "document" answer costs a round of review; a
// wrong "extraction" answer costs a full vision pass per page.
export async function scopeFeedback(
  ctx: PipelineContext,
  fragments: { order: number; innerHtml: string }[],
): Promise<FeedbackScope> {
  const feedback = ctx.feedback?.trim();
  if (!feedback) return { target: "document", pages: [], reason: "no feedback" };

  const fb = loadFeedbackAgent(ctx);
  if (!fb || fragments.length === 0) {
    return { target: "document", pages: [], reason: "feedback agent unavailable" };
  }

  const pageList = pageIndex(fragments);

  const user =
    `TASK: scope\n\n` +
    `## User feedback\n${feedback}\n\n` +
    `## Pages in this document (extracted HTML, truncated)\n${pageList}`;

  const res = await ctx.router.complete(FEEDBACK_AGENT, "text", [
    { role: "system", content: fb.content },
    { role: "user", content: user },
  ]);
  ctx.log.agentCall({ agent: fb, phase: "extraction", output: res.text });

  const parsed = extractJson<{ target?: string; pages?: unknown; reason?: string }>(res.text);
  const reason = parsed?.reason?.trim() || "no reason given";
  if (parsed?.target !== "extraction") {
    return { target: "document", pages: [], reason };
  }

  // Keep only page numbers that actually exist in this document; a hallucinated
  // page would otherwise silently re-extract nothing or throw downstream.
  const pages = knownPages(parsed.pages, fragments);

  // Source-level feedback that could not be localized: re-extracting the whole
  // document is too blunt (and too expensive) a response, and the review loop at
  // least applies the wording. Fall back rather than guess.
  if (pages.length === 0) {
    return { target: "document", pages: [], reason: `${reason} (no pages identified)` };
  }
  if (pages.length > Math.max(1, Math.floor(fragments.length * MAX_REEXTRACT_FRACTION))) {
    return {
      target: "document",
      pages: [],
      reason: `${reason} (${pages.length}/${fragments.length} pages — too broad to re-extract)`,
    };
  }

  return { target: "extraction", pages, reason };
}

// ---------------------------------------------------------------------------
// Regression gate (PRD §7.12): protect existing uses when an agent is updated
// ---------------------------------------------------------------------------

const MAX_GATE_FIXTURES = 3;
// An updated agent must still reproduce at least this fraction of the words in a
// fixture's accepted output (by screen-reader-flattened text); below it, the
// change is treated as a content regression.
export const MIN_CONTENT_COVERAGE = 0.85;
// Skip the coverage check for very short outputs, where one dropped word swings
// the ratio — rely on the model verdict alone there.
const MIN_COVERAGE_WORDS = 8;
// A proposed prompt change may not drop the agent's mean fixture coverage by more
// than this versus the current prompt (the holds-or-improves eval gate, #3).
const EVAL_REGRESSION_EPS = 0.02;

export interface RegressionResult {
  passed: boolean;
  failures: string[];
  meanCoverage: number | null; // mean content coverage of the candidate over fixtures
}

// How one fixture contributes to an agent's mean coverage. `null` means "abstain":
// this fixture is not counted in the mean at all.
//
// Both sides of the eval-regression comparison at the end of
// proposeAgentUpdatesFromFeedback MUST score fixtures by this one rule, because the
// comparison is a subtraction between two means. `regressionGate` scores the
// CANDIDATE prompt and `evalAgent` scores the CURRENT one; when they disagreed the
// difference between them was an artifact of the scoring, not of the prompts.
//
// `evalAgent` used to score an unjudgeable fixture (accepted text shorter than
// MIN_COVERAGE_WORDS, so contentCoverage abstains) as a perfect 1, while
// regressionGate excluded it. Since abstention depends only on `accepted_html`, the
// SAME fixture abstained on both sides — so the 1 landed on the current-prompt side
// only and inflated it. With MAX_GATE_FIXTURES = 3 that inflation is large: two
// judgeable fixtures at 0.90 plus one unjudgeable gave current 0.933 vs candidate
// 0.900, a 0.033 gap from padding alone, past EVAL_REGRESSION_EPS = 0.02. The gate
// blocked an update whose measurable coverage was IDENTICAL, and logged it as
// "eval_regression" — a real improvement discarded with a reason that named a
// regression that had not happened.
//
// No output is scored 0 rather than abstaining because producing nothing is a
// FAILURE on the fixture, not an absence of evidence: abstaining would let a prompt
// that returns nothing score exactly as well as one that handles the fixture.
// regressionGate already scores it 0 (and fails the fixture outright), so 0 is also
// the symmetric choice.
//
// It is the one input where "abstain" is not purely a property of the fixture:
// whether a prompt produced blocks is a property of THAT prompt, so a single fixture
// can be scored 0 for one prompt and excluded for the other. One direction is
// harmless — a silent CANDIDATE fails regressionGate outright, before the comparison.
// The other is a KNOWN, pre-existing hole, not closed here: if the CURRENT prompt
// flakes to no output on a fixture the candidate handles, the current side is
// deflated and the bar drops. Worked example — one unjudgeable fixture the current
// prompt flakes on plus one judgeable at 0.98: current = (0 + 0.98)/2 = 0.49, while
// the candidate abstains on the short one and scores 0.88 on the judgeable one. Then
// 0.88 < 0.49 - 0.02 is false and 0.88 clears MIN_CONTENT_COVERAGE, so a real 0.10
// coverage regression passes both gates. Fixing it means distinguishing "this prompt
// failed" from "this fixture cannot be judged" per side, which changes what the mean
// means; it is not a scoring-rule question. No test covers this direction yet.
function fixtureScore(coverage: number | null, blockCount: number): number | null {
  if (blockCount === 0) return 0;
  return coverage;
}

// Fraction of the accepted output's distinct words that still appear in the
// candidate output (screen-reader-flattened, punctuation-insensitive). Returns
// null when the accepted text is too short to judge reliably. Structural role
// markers that flatten() injects ([Heading 2], [List item], …) are stripped so a
// structure-only change is not mistaken for dropped content.
export function contentCoverage(acceptedHtml: string, candidateHtml: string): number | null {
  const words = (html: string): Set<string> =>
    new Set(
      flatten(html)
        .replace(/\[[^\]]*\]/g, " ")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 1),
    );
  const accepted = words(acceptedHtml);
  if (accepted.size < MIN_COVERAGE_WORDS) return null;
  const candidate = words(candidateHtml);
  let hit = 0;
  for (const w of accepted) if (candidate.has(w)) hit++;
  return hit / accepted.size;
}

// Re-run an agent (given its current/updated content) on a fixture image, used by
// the regression gate. Accepts either output shape: { html } (whole-page agents
// like page.md) or { no_content, fragments[] } (content agents).
async function reRunAgentOnImage(
  ctx: PipelineContext,
  agent: AgentSpec,
  img: InputImage,
): Promise<{ html: string }[]> {
  const system = `${agent.content}\n\n${ACCESSIBILITY_REQUIREMENTS}`;
  const user =
    `Process source image "${img.name}" exactly as your contract specifies and respond with ONLY ` +
    `JSON — either { "html": "<accessible HTML>" } for a whole-page agent, or ` +
    `{ "no_content": false, "fragments": [ { "html": "<accessible HTML>" } ] } for a content agent ` +
    `({ "no_content": true } if nothing matches).`;
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
  ctx.log.agentCall({ agent, phase: "review", image: img.name, output: res.text });
  const parsed = extractJson<{ no_content?: boolean; html?: string; fragments?: { html?: string }[] }>(res.text);
  if (!parsed || parsed.no_content) return [];
  if (parsed.html) return [{ html: parsed.html }];
  if (parsed.fragments?.length) return parsed.fragments.filter((f) => f.html).map((f) => ({ html: f.html! }));
  return [];
}

// Before an existing agent is updated/merged, re-run the UPDATED agent against its
// stored regression fixtures and verify each still passes. Blocks the change if
// any fixture regresses, so an agent can't be changed in a way that breaks a use
// it already handled. Passes when the agent has no fixtures yet.
export async function regressionGate(
  ctx: PipelineContext,
  agentFile: string,
  updatedContent: string,
): Promise<RegressionResult> {
  const dir = ctx.paths.agentFixtures(agentFile);
  if (!existsSync(dir)) return { passed: true, failures: [], meanCoverage: null };
  const caseFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, MAX_GATE_FIXTURES);
  if (caseFiles.length === 0) return { passed: true, failures: [], meanCoverage: null };

  const file = agentFile.endsWith(".md") ? agentFile : `${agentFile}.md`;
  const updatedAgent: AgentSpec = {
    name: file.replace(/\.md$/, ""),
    file,
    content: updatedContent,
    capabilities: /\bvision\b/i.test(updatedContent) ? ["vision"] : ["text"],
    sha: null,
    sessionBuilt: false,
  };

  const failures: string[] = [];
  const coverages: number[] = [];
  for (const caseFile of caseFiles) {
    let c: FixtureCase;
    try {
      c = JSON.parse(readFileSync(join(dir, caseFile), "utf8")) as FixtureCase;
    } catch {
      continue;
    }
    const imgPath = join(dir, c.image_file);
    if (!existsSync(imgPath)) continue;
    const img: InputImage = { name: c.source_image, order: 0, path: imgPath };
    const blocks = await reRunAgentOnImage(ctx, updatedAgent, img);
    if (blocks.length === 0) {
      failures.push(`${c.image_file}: updated agent produced no output`);
      // fixtureScore's no-output rule, which never abstains — see its comment for
      // why producing nothing scores 0 rather than dropping out of the mean.
      coverages.push(fixtureScore(null, 0) as number);
      continue;
    }
    // Content-preservation check: the updated agent must still reproduce the
    // content it produced when this fixture was accepted (PRD §7.12). Compare the
    // screen-reader-flattened text of the new output against the accepted output;
    // a large drop means the change regressed a use we already shipped.
    const candidateHtml = blocks.map((b) => b.html).join("\n\n");
    const coverage = contentCoverage(c.accepted_html, candidateHtml);
    const score = fixtureScore(coverage, blocks.length);
    if (score !== null) coverages.push(score);
    if (coverage !== null && coverage < MIN_CONTENT_COVERAGE) {
      failures.push(`${c.image_file}: only ${(coverage * 100).toFixed(0)}% of the accepted content remained`);
      continue;
    }
    const verdict = await verifyAgentOutput(ctx, updatedAgent, img, blocks);
    if (!verdict.ok) failures.push(`${c.image_file}: ${verdict.problems.join("; ") || "failed verification"}`);
  }

  const passed = failures.length === 0;
  const meanCoverage = coverages.length ? coverages.reduce((a, b) => a + b, 0) / coverages.length : null;
  ctx.log.event("regression_gate", { agent: file, cases: caseFiles.length, passed, failures: failures.length, meanCoverage });
  return { passed, failures, meanCoverage };
}

// Mean content coverage of an agent's content across its regression fixtures,
// reused as a lightweight eval set (#3). Returns null when there are no fixtures —
// and also when no fixture was judgeable, since a mean over zero measurements is not
// a score of zero. The caller compares this against regressionGate's meanCoverage,
// so it scores each fixture with the shared `fixtureScore` rule; see the comment
// there for why any divergence between the two makes the comparison meaningless.
export async function evalAgent(ctx: PipelineContext, agentFile: string, content: string): Promise<number | null> {
  const dir = ctx.paths.agentFixtures(agentFile);
  if (!existsSync(dir)) return null;
  const caseFiles = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, MAX_GATE_FIXTURES);
  if (caseFiles.length === 0) return null;
  const file = agentFile.endsWith(".md") ? agentFile : `${agentFile}.md`;
  const agent: AgentSpec = {
    name: file.replace(/\.md$/, ""),
    file,
    content,
    capabilities: /\bvision\b/i.test(content) ? ["vision"] : ["text"],
    sha: null,
    sessionBuilt: false,
  };
  const scores: number[] = [];
  for (const caseFile of caseFiles) {
    let c: FixtureCase;
    try {
      c = JSON.parse(readFileSync(join(dir, caseFile), "utf8")) as FixtureCase;
    } catch {
      continue;
    }
    const imgPath = join(dir, c.image_file);
    if (!existsSync(imgPath)) continue;
    const img: InputImage = { name: c.source_image, order: 0, path: imgPath };
    const blocks = await reRunAgentOnImage(ctx, agent, img);
    const cov = contentCoverage(c.accepted_html, blocks.map((b) => b.html).join("\n\n"));
    const score = fixtureScore(cov, blocks.length);
    if (score !== null) scores.push(score);
  }
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

// ---------------------------------------------------------------------------
// Feedback-driven agent training (PRD §7.12/§7.13)
// ---------------------------------------------------------------------------

// On a feedback re-run, turn the document-level correction (the prior reviewed
// body vs. this run's reviewed body) into an improved version of the agent that
// produced the document — the page agent in the single-pass pipeline. For a
// library agent the proposal is gated on its regression fixtures and then filed
// as a GitHub issue (the contribution model uses issues, not close-time PRs),
// while also being recorded in agent-updates.md; a session-built agent is trained
// in place so its new-agent contribution carries the fix.
export async function proposeAgentUpdatesFromFeedback(
  ctx: PipelineContext,
  args: { agentFile: string; before: string; after: string; feedback: string },
): Promise<AgentUpdateContribution[]> {
  const feedbackAgent = loadFeedbackAgent(ctx);
  if (!feedbackAgent) {
    ctx.log.event("feedback_agent_missing", {
      note: "agents/feedback.md not found; skipping agent-update proposals",
    });
    return [];
  }
  // Nothing changed this run -> no lesson to learn.
  if (!args.before.trim() || args.before.trim() === args.after.trim()) return [];

  const target = loadTargetAgent(ctx, args.agentFile);
  if (!target) {
    ctx.log.event("feedback_target_missing", { agent: args.agentFile });
    return [];
  }

  const correction = diffPreview(args.before, args.after);
  const user =
    `TASK: train\n\n` +
    `## Agent to improve: ${target.file}\n\`\`\`markdown\n${target.content}\n\`\`\`\n\n` +
    `## User feedback for this run\n${args.feedback}\n\n` +
    `## The correction the feedback caused (diff of the document body)\n\`\`\`diff\n${correction}\n\`\`\``;

  const res = await ctx.router.complete(FEEDBACK_AGENT, "text", [
    { role: "system", content: feedbackAgent.content },
    { role: "user", content: user },
  ]);
  ctx.log.agentCall({ agent: feedbackAgent, phase: "review", output: res.text });

  const parsed = extractJson<TrainOutput>(res.text);
  if (!parsed?.changed || !parsed.agent_markdown) return [];
  const updated = parsed.agent_markdown.trim();
  if (!updated || updated === target.content.trim()) return [];

  if (target.sessionBuilt) {
    // Train the session-built agent in place: overwrite its tmp file so the
    // new-agent PR opened on close carries the improved prompt.
    writeFileSync(join(ctx.paths.tmpAgentsDir(ctx.sessionId), target.file), updated);
    ctx.log.event("agent_trained", { agent: target.file, scope: "session_built" });
    return [];
  }

  // Existing library agent: gate the proposed update on its regression fixtures —
  // never propose a change that breaks a use it already handled.
  const gate = await regressionGate(ctx, target.file, updated);
  if (!gate.passed) {
    ctx.log.event("agent_update_blocked", { agent: target.file, failures: gate.failures });
    return [];
  }

  // Eval gate (#3): the proposed prompt must hold-or-improve the agent's mean
  // coverage over its fixtures versus the current prompt — not just pass the floor.
  //
  // Both means come from `fixtureScore`, so an UNJUDGEABLE fixture (the abstention
  // that depends only on accepted_html) is absent from both sides and the subtraction
  // below measures the prompts rather than the fixture mix. The one input that is not
  // symmetric this way is a prompt producing no output at all; see `fixtureScore` for
  // which direction of that is caught here and which remains open.
  //
  // Either side being null means there was nothing measurable to compare, which is
  // not evidence of a regression — the update proceeds on the regression gate's
  // verdict alone.
  const currentScore = await evalAgent(ctx, target.file, target.content);
  if (currentScore !== null && gate.meanCoverage !== null && gate.meanCoverage < currentScore - EVAL_REGRESSION_EPS) {
    ctx.log.event("agent_update_blocked", {
      agent: target.file,
      reason: "eval_regression",
      current: Number(currentScore.toFixed(3)),
      candidate: Number(gate.meanCoverage.toFixed(3)),
    });
    return [];
  }

  const proposal: AgentUpdateContribution = {
    agent_name: target.file,
    summary: parsed.summary?.trim() || `Improved ${target.name} from user feedback.`,
    diff_preview: diffPreview(target.content, updated),
    content: updated,
  };

  // Merge with any existing proposals (dedupe by agent_name; this run wins).
  const path = ctx.paths.sessionAgentUpdates(ctx.sessionId);
  let existing: AgentUpdateContribution[] = [];
  if (existsSync(path)) {
    try {
      const prior = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(prior)) existing = prior as AgentUpdateContribution[];
    } catch {
      existing = [];
    }
  }
  const merged = new Map<string, AgentUpdateContribution>();
  for (const p of existing) merged.set(p.agent_name, p);
  merged.set(proposal.agent_name, proposal);
  writeFileSync(path, JSON.stringify([...merged.values()], null, 2));

  ctx.log.event("agent_updates_proposed", { agents: [proposal.agent_name], count: 1 });

  // Surface the proposal where maintainers act on it: file a GitHub issue (the
  // contribution model uses issues, not close-time PRs). This is the path that makes
  // a user's feedback give back to the shared library — filed under their own GitHub
  // identity, which is why authenticating with GitHub is required (PRD §12).
  // `github.issue_token` overrides the attribution to a bot account. No-op without
  // any token, so local runs still keep the proposal in agent-updates.md.
  const usingServiceToken = Boolean(ctx.cfg.github.issue_token);
  const token = ctx.cfg.github.issue_token || ctx.githubToken;
  if (token) {
    try {
      const url = await createAgentUpdateIssue(token, ctx.cfg.github.upstream_repo, ctx.cfg.github.api_base_url, {
        agentName: proposal.agent_name,
        agentMarkdown: proposal.content,
        summary: proposal.summary,
        diffPreview: proposal.diff_preview,
        sessionId: ctx.sessionId,
      });
      ctx.log.event("agent_update_issue", { agent: proposal.agent_name, url: url ?? "(duplicate — skipped)" });
    } catch (e) {
      // Same soft failure and the same likely cause as runContribution's filing
      // path, so the same diagnosis — an operator debugging a dead
      // `iris-agent-update` label needs it as much as the suggestion one.
      ctx.log.event("agent_update_issue_failed", {
        agent: proposal.agent_name,
        error: (e as Error)?.message ?? String(e),
        ...scopeHintFor(e, { scope: ctx.cfg.github.oauth_scope, usingServiceToken }),
      });
    }
  } else {
    ctx.log.event("agent_update_issue_skipped", { agent: proposal.agent_name, reason: "no github token" });
  }

  return [proposal];
}

// Primary, low-rot learning path (#1/#2/#4/#5): classify a feedback correction and,
// when it's a generalizable or accessibility lesson (not a one-off specific to this
// document), distill it into a reusable instruction + localized before/after example
// and record it to the agent's example bank (memory.ts). Recorded lessons are
// corroborated across sessions and injected into the agent's prompt at run time —
// the agent file itself stays stable.
export async function learnFromFeedback(
  ctx: PipelineContext,
  args: { agentFile: string; before: string; after: string; feedback: string },
): Promise<void> {
  const fb = loadFeedbackAgent(ctx);
  if (!fb || !args.feedback.trim()) return;
  if (args.before.trim() === args.after.trim()) return; // nothing changed this run

  const correction = diffPreview(args.before, args.after);
  const user =
    `TASK: classify\n\n` +
    `## User feedback\n${args.feedback}\n\n` +
    `## How the document changed this run (diff)\n\`\`\`diff\n${correction}\n\`\`\``;
  const res = await ctx.router.complete(FEEDBACK_AGENT, "text", [
    { role: "system", content: fb.content },
    { role: "user", content: user },
  ]);
  ctx.log.agentCall({ agent: fb, phase: "review", output: res.text });

  const parsed = extractJson<ClassifyOutput>(res.text);
  const raw = parsed?.kind;
  if (!parsed || !parsed.instruction?.trim() || (raw !== "generalizable" && raw !== "a11y_policy")) {
    ctx.log.event("feedback_classified", { kind: raw ?? "unknown", recorded: false });
    return;
  }
  const kind: LessonKind = raw;
  const entry = recordExample(ctx.paths, {
    agent: args.agentFile,
    kind,
    instruction: parsed.instruction.trim(),
    before: (parsed.before ?? "").trim(),
    after: (parsed.after ?? "").trim(),
    feedback: args.feedback.trim(),
    session: ctx.sessionId,
  });
  ctx.log.event("feedback_learned", { agent: entry.agent, kind: entry.kind, count: entry.count, instruction: entry.instruction });
}
