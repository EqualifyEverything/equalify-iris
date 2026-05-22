// Mock GitHub + mock OpenRouter for the end-to-end curl test (test/e2e.sh).
// These stand in for the only two external dependencies so the whole API can be
// exercised offline. Not used in production.
import { createServer } from "node:http";

const GH_PORT = Number(process.env.MOCK_GH_PORT ?? 9301);
const OR_PORT = Number(process.env.MOCK_OR_PORT ?? 9302);

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}
function json(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// ---- Mock GitHub (covers both api.github.com and github.com OAuth paths) ----
const forks = new Set(); // repos that have been forked to the test user
let prNumber = 140;

const gh = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${GH_PORT}`);
  const p = url.pathname;
  const m = req.method;

  // OAuth / device flow
  if (m === "POST" && p === "/login/device/code")
    return json(res, 200, {
      device_code: "DEVICECODE123",
      user_code: "WXYZ-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 1,
    });
  if (m === "POST" && p === "/login/oauth/access_token")
    return json(res, 200, { access_token: "gho_testtoken", token_type: "bearer", scope: "repo" });

  // Authenticated user (api base): identifies the caller AND getAuthenticated()
  if (m === "GET" && p === "/user") return json(res, 200, { id: 4242, login: "iris-tester" });

  // repos.get
  let mm;
  if (m === "GET" && (mm = p.match(/^\/repos\/([^/]+)\/([^/]+)$/))) {
    const [, owner, repo] = mm;
    if (owner === "iris-tester") {
      if (forks.has(repo)) return json(res, 200, { fork: true, default_branch: "main", html_url: `https://github.com/iris-tester/${repo}` });
      return json(res, 404, { message: "Not Found" });
    }
    return json(res, 200, { fork: false, default_branch: "main", html_url: `https://github.com/${owner}/${repo}` });
  }
  // repos.createFork
  if (m === "POST" && (mm = p.match(/^\/repos\/([^/]+)\/([^/]+)\/forks$/))) {
    forks.add(mm[2]);
    return json(res, 202, { fork: true, default_branch: "main", html_url: `https://github.com/iris-tester/${mm[2]}` });
  }
  // git.getRef  GET /repos/:o/:r/git/ref/heads/:branch
  if (m === "GET" && p.match(/^\/repos\/[^/]+\/[^/]+\/git\/ref\//))
    return json(res, 200, { ref: "refs/heads/main", object: { sha: "baseSHA0000000000000000000000000000000000" } });
  // git.createRef
  if (m === "POST" && p.match(/^\/repos\/[^/]+\/[^/]+\/git\/refs$/))
    return json(res, 201, { ref: "refs/heads/new", object: { sha: "newSHA00000000000000000000000000000000000" } });
  // repos.getContent -> 404 so createOrUpdate treats it as a new file
  if (m === "GET" && p.match(/^\/repos\/[^/]+\/[^/]+\/contents\//)) return json(res, 404, { message: "Not Found" });
  // repos.createOrUpdateFileContents
  if (m === "PUT" && p.match(/^\/repos\/[^/]+\/[^/]+\/contents\//)) {
    await readBody(req);
    return json(res, 201, { content: { path: p }, commit: { sha: "commitSHA" } });
  }
  // pulls.create
  if (m === "POST" && (mm = p.match(/^\/repos\/([^/]+)\/([^/]+)\/pulls$/))) {
    await readBody(req);
    prNumber += 1;
    return json(res, 201, { number: prNumber, html_url: `https://github.com/${mm[1]}/${mm[2]}/pull/${prNumber}` });
  }

  json(res, 404, { message: `mock-github: unhandled ${m} ${p}` });
});

// ---- Mock OpenRouter (OpenAI-compatible chat completions) ----
const or = createServer(async (req, res) => {
  const body = await readBody(req);
  let sys = "";
  try {
    sys = JSON.parse(body).messages.find((x) => x.role === "system")?.content ?? "";
  } catch {}
  let content = "{}";
  if (sys.includes("Image Analysis Agent"))
    // Reference an unknown content type so the Builder Agent + PR path runs too.
    content = JSON.stringify({
      content_types: ["heading", "paragraph", "scientificNotation"],
      fragment_indicators: {},
      agent_calls: ["heading.md", "paragraph.md", "scientificNotation.md"],
      notes: [],
    });
  else if (sys.includes("Reader Agent")) content = JSON.stringify({ issues: [] });
  else if (sys.includes("Builder Agent"))
    // Return a content-agent markdown file (not JSON). Includes "specialist" so
    // its later extraction call hits the generic branch below.
    return json(res, 200, {
      choices: [
        {
          message: {
            content:
              "# ScientificNotation Agent\n## Purpose\nConvert inline scientific notation.\n## Required capability\nvision\n## System prompt\nYou are a specialist that converts scientific notation to accessible MathML. No styling.\n## Output contract\n@source-wrapped fragment plus a fragment log entry.",
          },
        },
      ],
    });
  else if (sys.includes("Heading Agent") || sys.includes("convert headings"))
    content = JSON.stringify({ no_content: false, fragments: [{ html: "<h1>Quarterly Report</h1>", fragment_edges: [], log: "" }] });
  else if (sys.includes("specialist"))
    content = JSON.stringify({ no_content: false, fragments: [{ html: "<p>Revenue grew this quarter.</p>", fragment_edges: [], log: "" }] });
  json(res, 200, { choices: [{ message: { content } }] });
});

gh.listen(GH_PORT, () => console.log(`mock-github on ${GH_PORT}`));
or.listen(OR_PORT, () => console.log(`mock-openrouter on ${OR_PORT}`));
