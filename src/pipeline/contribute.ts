import { loadAgent } from "../agents/loader.ts";
import { loadImage, type PipelineContext } from "./context.ts";
import { ACCESSIBILITY_REQUIREMENTS } from "./accessibility.ts";
import { createAgentIssue, installHintFor } from "../github/issue.ts";

// The content types the general page pass covers itself. A
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

const STANDARD_LOWER = new Set([...STANDARD].map((s) => s.toLowerCase()));

// The one way a suggestion's name is turned into a logical agent type, shared by both
// places that decide what to do with one (this file's contribution filter and
// extraction.ts's dispatch). It exists because the two used to normalize separately and
// drifted: trim-then-strip versus strip-then-trim disagreed on `"table.md "`.
//
// Trim before stripping the extension, not after — the other order leaves `"table.md "`
// as `"table.md"`, which is not a standard name, so a padded standard type gets past
// the filter. Then trim again, for `" table .md"`.
export function logicalType(name: string): string {
  return name.trim().replace(/\.md$/, "").trim();
}

// Whether a suggestion names a content type the general page pass already covers.
//
// Case-insensitive, because the name is free text a model wrote and the consequence of
// a miss is not symmetric. `STANDARD` spells one entry `formField`, so `"FormField"` or
// `"Table"` — spellings a model will produce, since these are prose descriptions of
// content types and not filenames — used to fall through to `draftAgent` and
// `createAgentIssue`: a public issue on the upstream repo, filed under the USER's own
// GitHub identity, proposing a specialist for a type the page pass has always
// handled. A false decline costs one specialist that the page pass covers anyway; a
// false accept costs a real person's name on a spurious proposal.
//
// This used to be backstopped by `loadAgent` finding `agents/table.md` — on a
// case-insensitive volume, `agents/Table.md` too. Those nine files are gone (they
// were unreachable), so this predicate is the whole filter.
// Takes a name ALREADY through `logicalType`, and does not re-normalize. An earlier
// version called `logicalType` here as well, which was worse than redundant: both call
// sites pass a normalized name, so `"table.md "` got its extension stripped twice and
// arrived as `"table"` no matter what `logicalType` did — the double strip silently
// covered for a broken normalizer, and a sabotage of `logicalType` went undetected here
// while failing at the dispatch site. One normalization, at the call site, where it is
// visible.
export function isStandardType(logical: string): boolean {
  return STANDARD_LOWER.has(logical.toLowerCase());
}

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
    { step: "contribute", images: img ? [loadImage(img)] : [] },
  );
  return res.text.trim();
}

// For each genuinely-new suggested content type, draft an agent and file a
// labeled GitHub issue with the code + context.
//
// Filed under the LOGGED-IN USER's identity, which is the whole reason GitHub is
// the auth layer: using Iris and giving back to the shared agent library are the
// same act, credited to the person who did it. `github.issue_token` is an
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
    // Normalized and tested for standardness the same way dispatchSpecialist does it —
    // one shared pair of functions, because when the two normalized separately they
    // disagreed and the disagreement was a filed issue. See `isStandardType` for why
    // the fallthrough is expensive: a draft is a vision call, and the issue goes up
    // under the user's own GitHub identity.
    const name = logicalType(s.name);
    if (!name || isStandardType(name) || seen.has(name.toLowerCase())) continue;
    // Deduplicated case-insensitively too: `"chartData"` and `"chartdata"` in one run
    // are two vision calls and two issues for the same proposal.
    seen.add(name.toLowerCase());
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
      // diagnosis — see installHintFor.
      ctx.log.event("agent_issue_failed", {
        agent: name,
        error: (e as Error)?.message ?? String(e),
        stage: "file",
        ...installHintFor(e, { usingServiceToken }),
      });
    }
  }
}
