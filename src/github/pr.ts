import { Octokit } from "@octokit/rest";
import { createHash } from "node:crypto";

export interface RepoRef {
  owner: string;
  repo: string;
}

export function parseRepo(url: string): RepoRef {
  const m = url.replace(/\.git$/, "").match(/github\.com[/:]([^/]+)\/([^/]+)/);
  if (!m) throw new Error(`cannot parse GitHub repo from "${url}"`);
  return { owner: m[1], repo: m[2] };
}

function shortHash(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 4);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Ensure the user has a fork of the upstream repo (PRD §7.13: created lazily on
// first close). Returns the fork's html_url.
export async function ensureFork(octokit: Octokit, upstream: RepoRef): Promise<string> {
  const me = (await octokit.users.getAuthenticated()).data.login;
  try {
    const existing = await octokit.repos.get({ owner: me, repo: upstream.repo });
    if (existing.data.fork) return existing.data.html_url;
  } catch {
    // not found -> create below
  }
  const created = await octokit.repos.createFork({ owner: upstream.owner, repo: upstream.repo });
  // Forking is asynchronous on GitHub; wait until the repo is queryable.
  for (let i = 0; i < 10; i++) {
    try {
      await octokit.repos.get({ owner: me, repo: upstream.repo });
      break;
    } catch {
      await sleep(2000);
    }
  }
  return created.data.html_url;
}

// A file to commit to the PR branch. Text content is given as a string; binary
// content (e.g. a fixture image) as a Buffer.
export interface PrFile {
  path: string; // path within the repo, e.g. agents/foo.md
  content: string | Buffer;
}

interface OpenPrArgs {
  upstream: RepoRef;
  forkOwner: string;
  branchPrefix: string;
  nameForBranch: string; // used in branch name + hashing
  files: PrFile[]; // agent file plus any test fixtures (§7.13)
  title: string;
  body: string;
}

export interface OpenedPr {
  pr_url: string;
  branch: string;
}

function toBase64(content: string | Buffer): string {
  return Buffer.isBuffer(content) ? content.toString("base64") : Buffer.from(content, "utf8").toString("base64");
}

// Create a branch on the user's fork, commit the files, and open a PR upstream.
export async function openPr(octokit: Octokit, args: OpenPrArgs): Promise<OpenedPr> {
  const { upstream, forkOwner } = args;
  const hashSeed = args.files.map((f) => (Buffer.isBuffer(f.content) ? f.content.toString("base64") : f.content)).join("|");
  const branch = `${args.branchPrefix}/${args.nameForBranch}-${shortHash(args.nameForBranch, hashSeed)}`;

  // Base off upstream's default branch HEAD.
  const upstreamRepo = await octokit.repos.get({ owner: upstream.owner, repo: upstream.repo });
  const base = upstreamRepo.data.default_branch;
  const baseRef = await octokit.git.getRef({ owner: upstream.owner, repo: upstream.repo, ref: `heads/${base}` });
  const baseSha = baseRef.data.object.sha;

  // Create the branch on the fork.
  await octokit.git.createRef({ owner: forkOwner, repo: upstream.repo, ref: `refs/heads/${branch}`, sha: baseSha });

  // Commit each file to the branch on the fork (create or update).
  for (const file of args.files) {
    let existingSha: string | undefined;
    try {
      const existing = await octokit.repos.getContent({ owner: forkOwner, repo: upstream.repo, path: file.path, ref: branch });
      if (!Array.isArray(existing.data) && "sha" in existing.data) existingSha = existing.data.sha;
    } catch {
      // file does not exist on this branch yet
    }
    await octokit.repos.createOrUpdateFileContents({
      owner: forkOwner,
      repo: upstream.repo,
      path: file.path,
      message: `${args.title}: ${file.path}`,
      content: toBase64(file.content),
      branch,
      sha: existingSha,
    });
  }

  // Open the PR upstream from fork:branch.
  const pr = await octokit.pulls.create({
    owner: upstream.owner,
    repo: upstream.repo,
    title: args.title,
    body: args.body,
    head: `${forkOwner}:${branch}`,
    base,
  });
  return { pr_url: pr.data.html_url, branch };
}
