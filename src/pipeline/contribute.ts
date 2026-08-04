import { loadAgent } from "../agents/loader.ts";
import { loadImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { createAgentIssue, scopeHintFor } from "../github/issue.ts";

// Content types already covered by the standard library — never suggest these,
// and never dispatch the generic page extraction to them (see extraction.ts).
export const STANDARD = new Set([
  "paragraph", "heading", "list", "table", "formField", "image", "quote", "caption", "footnote",
]);

const DRAFT_SYSTEM = `Draft a NEW content-agent markdown file for a content type the general extractor flagged as
needing a specialist. The file MUST contain these sections:

# <Type> Agent
## Purpose
## Required capability     (one or more of: text, vision, structured_output)
## System prompt           (specialist instructions; demand semantic, accessible HTML; forbid CSS/styling)
## Output contract         (an accessible HTML fragment)

Return ONLY the markdown file content (no code fences).`;

export interface Suggestion {
  name: string;
  reason: string;
  image: string;
}

async function draftAgent(ctx: PipelineContext, s: Suggestion): Promise<string> {
  const img = ctx.images.find((i) => i.name === s.image);
  const res = await ctx.router.complete(
    "builder",
    "vision",
    [
      { role: "system", content: DRAFT_SYSTEM },
      {
        role: "user",
        content: `Draft an agent for content type "${s.name}". Why a specialist is warranted: ${s.reason}. First seen on "${s.image}".\n\n${ACCESSIBILITY_REQUIREMENTS}`,
      },
    ],
    { images: img ? [loadImage(img)] : [] },
  );
  return res.text.trim();
}

// For each genuinely-new suggested content type, draft an agent and file a
// labeled GitHub issue with the code + context.
//
// This is a no-op only when there is NO token at all. It used to say "no-op
// without a service token, so we never publish under end users' identities",
// which the code has not done for some time: `issue_token` is an override, and
// without it the issue is filed as the logged-in user. That is now the documented
// default shape for a public upstream (README, "Read this before you deploy"),
// with `issue_token` + `oauth_scope: none` as the recommended production shape.
export async function runContribution(ctx: PipelineContext, suggestions: Suggestion[]): Promise<void> {
  // Attribute issues to the logged-in user by default; a configured service
  // token overrides that (e.g. to file everything under a bot account).
  const token = ctx.cfg.github.issue_token || ctx.githubToken;
  if (!token || suggestions.length === 0) return;

  const seen = new Set<string>();
  for (const s of suggestions) {
    // Trim first, then strip the extension — same order as dispatchSpecialist, and
    // for the same reason: the other way round leaves `"table.md "` as `"table.md"`,
    // which STANDARD does not contain, so a padded standard name gets past the
    // filter. Here that only costs a redundant issue (loadAgent below still finds
    // `agents/table.md` and skips it), but the two call sites resolving one model
    // string differently is a bug waiting for the next reader.
    const name = s.name.trim().replace(/\.md$/, "").trim();
    if (!name || STANDARD.has(name) || seen.has(name)) continue;
    seen.add(name);
    // Skip if the library (or this session) already has the agent.
    if (loadAgent(name, { agentsDir: ctx.paths.agentsDir, tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId) })) continue;
    try {
      const markdown = await draftAgent(ctx, s);
      const url = await createAgentIssue(token, ctx.cfg.github.upstream_repo, ctx.cfg.github.api_base_url, {
        agentName: name,
        agentMarkdown: markdown,
        reason: s.reason,
        sourcePage: s.image,
        sessionId: ctx.sessionId,
      });
      ctx.log.event("agent_issue", { agent: name, url: url ?? "(duplicate — skipped)" });
    } catch (e) {
      // A 403 is swallowed here by design, so the log line has to carry the
      // diagnosis — see scopeHintFor.
      ctx.log.event("agent_issue_failed", {
        agent: name,
        error: (e as Error).message,
        ...scopeHintFor(e, ctx.cfg.github.oauth_scope),
      });
    }
  }
}
