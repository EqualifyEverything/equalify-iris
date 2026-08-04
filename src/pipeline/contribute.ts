import { loadAgent } from "../agents/loader.ts";
import { loadImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { createAgentIssue, scopeHintFor } from "../github/issue.ts";

// The content types the general page pass covers itself (PRD §7.4 v1.2). A
// suggestion naming one of these is declined rather than dispatched, and never
// filed as a new agent to build (see extraction.ts).
//
// These were nine agent FILES until they were deleted as unreachable: every one of
// them was declined by name here before `loadAgent` was ever called, so no run
// could reach them. The list outlived the files because it was never really a
// mirror of the library — it is the boundary of what one whole-page vision call
// handles, which is exactly the question a suggestion asks. Keeping it as data
// rather than as a directory listing also makes the decline independent of what
// happens to be on disk: a deployment that drops a file into `agents/` named
// `table.md` still does not get a second rendering of a table spliced over the
// page's own.
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
// Filed under the LOGGED-IN USER's identity, which is the whole reason GitHub is
// the auth layer: using Iris and giving back to the shared agent library are the
// same act, credited to the person who did it (PRD §12). `github.issue_token` is an
// optional override for deployments that must file under one bot account instead,
// and it trades that attribution away.
export async function runContribution(ctx: PipelineContext, suggestions: Suggestion[]): Promise<void> {
  // Which credential is used decides what a 403 means, so it is recorded rather
  // than re-derived at the failure.
  const usingServiceToken = Boolean(ctx.cfg.github.issue_token);
  const token = ctx.cfg.github.issue_token || ctx.githubToken;
  if (!token || suggestions.length === 0) return;

  const seen = new Set<string>();
  for (const s of suggestions) {
    // Trim first, then strip the extension — same order as dispatchSpecialist, and
    // for the same reason: the other way round leaves `"table.md "` as `"table.md"`,
    // which STANDARD does not contain, so a padded standard name gets past the
    // filter. The `loadAgent` check below used to catch it anyway (it resolved to
    // `agents/table.md`), which made this the cheap call site; the nine standard
    // agent files are gone (§7.4 v1.2), so nothing resolves and the fallthrough now
    // drafts and FILES an upstream issue proposing a `table` agent — for a type the
    // page pass covers, under the user's own GitHub identity. Order matters here on
    // its own merits, not just for consistency with the other call site.
    const name = s.name.trim().replace(/\.md$/, "").trim();
    if (!name || STANDARD.has(name) || seen.has(name)) continue;
    seen.add(name);
    // Skip if the library (or this session) already has the agent.
    if (loadAgent(name, { agentsDir: ctx.paths.agentsDir, tmpAgentsDir: ctx.paths.tmpAgentsDir(ctx.sessionId) })) continue;
    // Drafting is a MODEL call and is kept out of the GitHub try below: a
    // provider error is a plain Error whose message can contain "403"
    // (src/providers/openrouter.ts formats the status into the text), and inside
    // one try it would be indistinguishable from a GitHub permissions failure.
    // Both still fail softly — a contribution is a side effect.
    let markdown: string;
    try {
      markdown = await draftAgent(ctx, s);
    } catch (e) {
      ctx.log.event("agent_issue_failed", { agent: name, error: (e as Error)?.message ?? String(e), stage: "draft" });
      continue;
    }
    try {
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
        error: (e as Error)?.message ?? String(e),
        stage: "file",
        ...scopeHintFor(e, { scope: ctx.cfg.github.oauth_scope, usingServiceToken }),
      });
    }
  }
}
