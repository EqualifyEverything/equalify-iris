import { Octokit } from '@octokit/rest';

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface IssueCreateOptions {
  type: 'new_agent' | 'agent_update';
  agentName: string;
  summary: string;
  outputHtml?: string;
  diffPreview?: string;
  triggeredBy?: string;
  lintResult?: string;
}

export interface CreatedIssue {
  issue_url: string;
  issue_number: number;
}

/**
 * Create an issue in the upstream repo to propose a new agent or agent update.
 * Issues are attributed to the authenticated user and will be visible with a GitHub App badge.
 */
export async function createIssue(
  octokit: Octokit,
  upstream: RepoRef,
  options: IssueCreateOptions,
): Promise<CreatedIssue> {
  const { type, agentName, summary, outputHtml, diffPreview, triggeredBy, lintResult } = options;

  let title: string;
  let body: string;

  if (type === 'new_agent') {
    title = `Add ${agentName} content agent`;
    body =
      `## Proposed New Agent\n\n` +
      `**Agent**: ${agentName}\n` +
      `**Why**: ${summary}\n` +
      (triggeredBy ? `**Triggered by**: ${triggeredBy}\n` : '') +
      (lintResult ? `**Accessibility lint**: ${lintResult}\n` : '') +
      `\n---\n\n` +
      (outputHtml
        ? `### Sample output from this agent\n\n\`\`\`html\n${outputHtml.slice(0, 500)}${outputHtml.length > 500 ? '\n...(truncated)' : ''}\n\`\`\``
        : `No sample output available.`) +
      `\n\n_Opened automatically from an Equalify Iris session._`;
  } else {
    // agent_update
    title = `Update ${agentName}`;
    body =
      `## Proposed Agent Update\n\n` +
      `**Agent**: ${agentName}\n` +
      `**Changes**: ${summary}\n\n` +
      (diffPreview ? `\`\`\`diff\n${diffPreview}\n\`\`\`\n` : '') +
      `\n_Opened automatically from an Equalify Iris session._`;
  }

  const issue = await octokit.issues.create({
    owner: upstream.owner,
    repo: upstream.repo,
    title,
    body,
  });

  return {
    issue_url: issue.data.html_url,
    issue_number: issue.data.number,
  };
}
