import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractJson } from "../util/json.ts";
import { loadAgent, type AgentSpec } from "../agents/loader.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { loadImage, type InputImage, type PipelineContext } from "./context.ts";
import { flatten } from "./flatten.ts";
import { createAgentUpdateIssue } from "../github/issue.ts";
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

export interface RegressionResult {
  passed: boolean;
  failures: string[];
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
  if (!existsSync(dir)) return { passed: true, failures: [] };
  const caseFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, MAX_GATE_FIXTURES);
  if (caseFiles.length === 0) return { passed: true, failures: [] };

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
      continue;
    }
    // Content-preservation check: the updated agent must still reproduce the
    // content it produced when this fixture was accepted (PRD §7.12). Compare the
    // screen-reader-flattened text of the new output against the accepted output;
    // a large drop means the change regressed a use we already shipped.
    const candidateHtml = blocks.map((b) => b.html).join("\n\n");
    const coverage = contentCoverage(c.accepted_html, candidateHtml);
    if (coverage !== null && coverage < MIN_CONTENT_COVERAGE) {
      failures.push(`${c.image_file}: only ${(coverage * 100).toFixed(0)}% of the accepted content remained`);
      continue;
    }
    const verdict = await verifyAgentOutput(ctx, updatedAgent, img, blocks);
    if (!verdict.ok) failures.push(`${c.image_file}: ${verdict.problems.join("; ") || "failed verification"}`);
  }

  const passed = failures.length === 0;
  ctx.log.event("regression_gate", { agent: file, cases: caseFiles.length, passed, failures: failures.length });
  return { passed, failures };
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
  // contribution model uses issues, not close-time PRs). Attributed to the
  // logged-in user unless a service token override is configured. No-op without a
  // token, so local runs still keep the proposal in agent-updates.md.
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
      ctx.log.event("agent_update_issue_failed", { agent: proposal.agent_name, error: (e as Error).message });
    }
  } else {
    ctx.log.event("agent_update_issue_skipped", { agent: proposal.agent_name, reason: "no github token" });
  }

  return [proposal];
}
