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
