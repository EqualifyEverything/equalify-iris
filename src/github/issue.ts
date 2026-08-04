import { Octokit } from "@octokit/rest";

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepo(url: string): RepoRef {
  const m = url.replace(/\.git$/, "").match(/github\.com[/:]([^/]+)\/([^/]+)/);
  if (!m) throw new Error(`cannot parse GitHub repo from "${url}"`);
  return { owner: m[1], repo: m[2] };
}

// Label maintainers can sort/filter agent suggestions by.
export const AGENT_LABEL = "iris-agent-suggestion";

// Why an issue-filing failure was probably about the token's permissions, or
// undefined if it was not.
//
// Both filing paths (a new-agent suggestion and an agent-update proposal) fail
// softly — a contribution is a side effect and a GitHub outage must not fail a
// document the user already paid for — so the log line is the only place the cause
// can appear. And the cause is several steps away from the failure: which token
// was used depends on config, and what that token may do was decided elsewhere
// (at consent time for a user's, on github.com for a service PAT). Neither of the
// two user-token cases can be seen from config alone, which is why this lives at
// the failure rather than at startup:
//
//   - `oauth_scope` narrower than a PRIVATE `upstream_repo` needs. `public_repo`
//     is the default, so an existing private-upstream deployment can acquire this
//     on upgrade without touching its config.
//   - A token issued BEFORE the requested scope was narrowed, which keeps the old
//     scope until the user re-authorizes.
//
// Both 403 and 404 are diagnosed, and the FIRST case above is the 404 one: GitHub
// does not leak the existence of a private repository, so a token without access
// to one gets `404 Not Found` rather than a permissions error. Treating 403 as the
// only permissions signal would have missed exactly the case this hint was written
// for. 404 is genuinely ambiguous, though — a misspelled `upstream_repo` produces
// the same status — so that wording names both possibilities instead of asserting
// one.
//
// `usingServiceToken` is load-bearing, not decoration: when `github.issue_token`
// is set it is that PAT that failed, and `oauth_scope` has nothing to do with it.
// Naming `oauth_scope` there would send an operator to widen the user grant this
// service is trying to keep narrow, to fix a failure widening it cannot touch —
// and that is the shape the README recommends for production.
export function scopeHintFor(
  e: unknown,
  opts: { scope: string; usingServiceToken: boolean },
): { hint: string } | undefined {
  // Octokit's RequestError carries the code on `.status`, and only calls that
  // actually reached GitHub produce one. Deliberately NOT falling back to
  // matching the code in the message: a provider error is a plain
  // `Error("openrouter 403: ...")` (src/providers/openrouter.ts), so the text
  // fallback would attach a GitHub-permissions hint to a failure that never
  // reached GitHub. Callers keep non-GitHub work out of the try as well.
  // Optional-chained: a thrown null would otherwise throw from inside the caller's
  // catch, and that catch runs after the document is already delivered.
  const status = (e as { status?: number } | null)?.status;
  if (status !== 403 && status !== 404) return undefined;
  // GitHub also answers 403 for primary and secondary rate limits, where
  // permissions are irrelevant and this hint would send an operator to the wrong
  // config key. Checked on the response headers first (`x-ratelimit-remaining: 0`
  // is the primary-limit signal) and on the message text for the secondary limit,
  // which says so in prose rather than in a header.
  const message = (e as Error | null)?.message ?? "";
  const headers = (e as { response?: { headers?: Record<string, string> } } | null)?.response?.headers ?? {};
  if (headers["x-ratelimit-remaining"] === "0" || /rate limit|abuse|secondary limit/i.test(message)) {
    return undefined;
  }
  // A missing repo is reported the same way whichever credential was used, so this
  // possibility is named in both branches below.
  const notFound = status === 404;
  if (opts.usingServiceToken) {
    return {
      hint:
        `${status} while filing as the service account: github.issue_token is set, so the failing ` +
        `credential is that PAT — check its scopes and its access to upstream_repo on github.com` +
        (notFound ? `, and check that upstream_repo is spelled correctly (GitHub answers 404 for a repo a token cannot see)` : ``) +
        `. github.oauth_scope is not involved; it only governs tokens issued to users.`,
    };
  }
  return {
    hint:
      (notFound
        ? // The private-upstream case. GitHub hides the repo rather than refusing,
          // so this reads as "no such repo" until you know to suspect the scope.
          `404 on a repo that exists means the user's token cannot see it: a PRIVATE upstream_repo needs "repo". ` +
          `(A misspelled upstream_repo gives the same 404.) `
        : `403 usually means the user's token lacks the scope this repo needs. `) +
      // `none` rather than a bare "" — an empty string reads as unset rather than
      // as the deliberate setting the operator wrote.
      `github.oauth_scope is "${opts.scope || "none"}". ` +
      `Tokens issued before a scope change keep the old scope until the user re-authorizes.`,
  };
}

async function ensureLabel(
  octokit: Octokit,
  repo: RepoRef,
  name: string = AGENT_LABEL,
  color = "5319e7",
  description = "Agent suggested automatically by Equalify Iris",
): Promise<void> {
  try {
    await octokit.issues.getLabel({ owner: repo.owner, repo: repo.repo, name });
  } catch {
    try {
      await octokit.issues.createLabel({ owner: repo.owner, repo: repo.repo, name, color, description });
    } catch {
      // label may have been created concurrently, or insufficient perms — the
      // issue create below still works if the label already exists.
    }
  }
}

export interface AgentIssue {
  agentName: string;
  agentMarkdown: string;
  reason: string;
  sourcePage: string;
  sessionId: string;
}

// File a labeled issue containing the drafted agent code + context. Returns the
// issue URL, or null if an open issue for this agent already exists (dedupe).
export async function createAgentIssue(
  token: string,
  upstreamUrl: string,
  apiBase: string,
  args: AgentIssue,
): Promise<string | null> {
  const octokit = new Octokit({ auth: token, baseUrl: apiBase });
  const repo = parseRepo(upstreamUrl);
  const title = `New agent suggestion: ${args.agentName}`;

  // Dedupe: skip if an open suggestion issue with this title already exists.
  try {
    const found = await octokit.search.issuesAndPullRequests({
      q: `repo:${repo.owner}/${repo.repo} is:issue is:open label:"${AGENT_LABEL}" "${args.agentName}" in:title`,
    });
    if (found.data.items.some((i) => i.title === title)) return null;
  } catch {
    // search unavailable — proceed (a duplicate is acceptable; not worth failing).
  }

  await ensureLabel(octokit, repo);
  const body =
    `**Content type:** \`${args.agentName}\`\n` +
    `**Why a dedicated agent:** ${args.reason}\n` +
    `**First seen on:** ${args.sourcePage} (session ${args.sessionId})\n\n` +
    `_Auto-filed by Equalify Iris when a page contained content a specialist agent would handle better than the general pass._\n\n` +
    `## Proposed agent — \`agents/${args.agentName}.md\`\n\n` +
    "```markdown\n" + args.agentMarkdown + "\n```\n";
  const res = await octokit.issues.create({
    owner: repo.owner,
    repo: repo.repo,
    title,
    body,
    labels: [AGENT_LABEL],
  });
  return res.data.html_url;
}

// Label for feedback-driven improvements to an EXISTING agent (distinct from new
// agent suggestions, so maintainers can triage them separately).
export const AGENT_UPDATE_LABEL = "iris-agent-update";

export interface AgentUpdateIssue {
  agentName: string; // e.g. "page.md"
  agentMarkdown: string; // full proposed updated agent file
  summary: string; // one-line description of the change
  diffPreview: string; // human-readable diff of the proposed change
  sessionId: string;
}

// File a labeled issue proposing an improvement to an existing agent, produced by
// the feedback loop (and already gated by the agent's regression fixtures).
// Returns the issue URL, or null if an open update issue for this agent already
// exists (dedupe by title).
export async function createAgentUpdateIssue(
  token: string,
  upstreamUrl: string,
  apiBase: string,
  args: AgentUpdateIssue,
): Promise<string | null> {
  const octokit = new Octokit({ auth: token, baseUrl: apiBase });
  const repo = parseRepo(upstreamUrl);
  const name = args.agentName.replace(/\.md$/, "");
  const title = `Agent update proposal: ${name}`;

  // Dedupe: skip if an open update issue with this title already exists.
  try {
    const found = await octokit.search.issuesAndPullRequests({
      q: `repo:${repo.owner}/${repo.repo} is:issue is:open label:"${AGENT_UPDATE_LABEL}" "${name}" in:title`,
    });
    if (found.data.items.some((i) => i.title === title)) return null;
  } catch {
    // search unavailable — proceed (a duplicate is acceptable; not worth failing).
  }

  await ensureLabel(
    octokit,
    repo,
    AGENT_UPDATE_LABEL,
    "0e8a16",
    "Agent improvement proposed by Equalify Iris from user feedback",
  );
  const body =
    `**Agent:** \`agents/${name}.md\`\n` +
    `**Proposed change:** ${args.summary}\n` +
    `**Session:** ${args.sessionId}\n\n` +
    `_Auto-filed by Equalify Iris when user feedback produced a generalizable improvement to this agent. ` +
    `Already gated by the agent's regression fixtures._\n\n` +
    `## Diff (preview)\n\n` +
    "```diff\n" + args.diffPreview + "\n```\n\n" +
    `## Proposed full \`agents/${name}.md\`\n\n` +
    "```markdown\n" + args.agentMarkdown + "\n```\n";
  const res = await octokit.issues.create({
    owner: repo.owner,
    repo: repo.repo,
    title,
    body,
    labels: [AGENT_UPDATE_LABEL],
  });
  return res.data.html_url;
}
