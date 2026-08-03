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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// When set, every completion returns a TRUNCATED response (see below). Toggled at
// runtime via POST /__truncate so one mock process can serve both a normal run and
// a truncation run — the mock boots once for the whole e2e.
let truncateNext = false;

// When set, the page agent's response carries a `suggested_agent` with this name,
// so the e2e can drive specialist dispatch. Set to a real library agent to make
// dispatch succeed, or to a name no file matches to make it MISS — the case the
// service used to handle silently. Toggled via POST /__suggest.
let suggestAgent = null;

const or = createServer(async (req, res) => {
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/__truncate") {
    truncateNext = !truncateNext;
    return json(res, 200, { truncate: truncateNext });
  }
  if (req.method === "POST" && new URL(req.url, "http://x").pathname === "/__suggest") {
    const raw = await readBody(req);
    suggestAgent = JSON.parse(raw || "{}").name ?? null;
    return json(res, 200, { suggest: suggestAgent });
  }
  const body = await readBody(req);
  let sys = "";
  let user = "";
  let imageParts = 0;
  try {
    const msgs = JSON.parse(body).messages;
    sys = msgs.find((x) => x.role === "system")?.content ?? "";
    const u = msgs.find((x) => x.role === "user")?.content;
    // Vision requests send content as an array of parts: one text part plus one
    // image_url part per attached image.
    user = typeof u === "string" ? u : (u ?? []).map((p) => p.text ?? "").join(" ");
    if (Array.isArray(u)) imageParts = u.filter((p) => p.type === "image_url").length;
  } catch {}
  let content = "{}";
  // Feedback Agent, TASK: scope — route feedback to extraction or the review loop.
  // Keyed off the feedback text so the e2e can drive either path: a message naming
  // a page and a misread is source-level, anything else is document-level.
  if (user.includes("TASK: scope")) {
    const m = user.match(/misread on page (\d+)/i);
    content = m
      ? JSON.stringify({ target: "extraction", pages: [Number(m[1])], reason: "source misread" })
      : JSON.stringify({ target: "document", pages: [], reason: "document-level wording" });
  } else if (sys.includes("convert an ENTIRE document page")) {
    // Echo the page number back so the assembled document proves page ORDER was
    // preserved. Pages are extracted in parallel, so respond SLOWEST-FIRST:
    // page 1 is delayed the longest, meaning completion order is the reverse of
    // document order. If ordering were driven by completion, the output would
    // come out backwards and the e2e ordering assertion would catch it.
    const m = user.match(/page (\d+) of (\d+)/);
    const page = m ? Number(m[1]) : 1;
    const total = m ? Number(m[2]) : 1;
    await sleep(Math.max(0, (total - page + 1) * 120));
    // A re-extraction prompt carries the page's previous output. Mark the result
    // so the e2e can prove that ONLY the targeted page was re-extracted.
    const revised = user.includes("## Your previous output for this page");
    content = JSON.stringify({
      html:
        `<h1>Quarterly Report</h1>\n<p>Revenue grew this quarter.</p>\n` +
        `<p>Page marker ${page}.${revised ? " Revised." : ""}</p>`,
      log: "",
      // Only when the e2e has armed it, and only on page 1, so the run yields
      // exactly one dispatch attempt to assert on.
      ...(suggestAgent && page === 1
        ? { suggested_agent: { name: suggestAgent, reason: "e2e-driven dispatch" } }
        : {}),
    });
  } else if (user.includes("Extract ONLY the content your contract covers")) {
    // A dispatched library specialist. Returns a marked fragment so the e2e can
    // tell a dispatch that ran from one that was skipped.
    content = JSON.stringify({ no_content: false, html: `<p>Specialist fragment.</p>` });
  } else if (sys.includes("You merge a higher-fidelity HTML fragment")) {
    // The merge step, which folds the specialist fragment back into the page.
    content = JSON.stringify({
      html:
        `<h1>Quarterly Report</h1>\n<p>Revenue grew this quarter.</p>\n` +
        `<p>Page marker 1.</p>\n<p>Specialist fragment.</p>`,
    });
  } else if (sys.includes("Reader Agent")) {
    // Normally clean. When the run carries feedback asking for a copy-edit pass,
    // report ONE issue attributed to page 2 — that drives the editor and lets the
    // e2e prove only page 2's image was attached. Issues are reported on every
    // round (the mock document never changes), so the loop runs to its cap.
    content = user.includes("headings need a copy-edit pass")
      ? JSON.stringify({
          issues: [
            {
              issue: "The revenue table on page 2 has no column headers.",
              pages: [2],
              severity: "high",
              suggested_action: "add <th scope=\"col\"> to the table",
            },
          ],
        })
      : JSON.stringify({ issues: [] });
  } else if (sys.includes("Copy Editor Agent")) {
    // Echo how many page images were attached so the e2e can assert the payload
    // was scoped to the attributed page rather than the whole document.
    const attached = imageParts;
    content = JSON.stringify({
      html:
        `<h1>Quarterly Report</h1>\n<p>Revenue grew this quarter.</p>\n` +
        `<p>Page marker 1.</p>\n<p>Page marker 2.</p>\n<p>Page marker 3.</p>\n` +
        `<p>Editor saw ${attached} image(s).</p>`,
    });
  }
  // Truncation: a 200 carrying PARTIAL content plus finish_reason "length" —
  // exactly what a model returns when it stops at the output ceiling. The payload
  // is deliberately plausible-looking JSON cut mid-tag, which is what makes this
  // dangerous: without the provider-level guard it would be assembled into the
  // deliverable as if it were genuine content.
  if (truncateNext) {
    return json(res, 200, {
      choices: [{ message: { content: '{"html":"<table><tr><td>cut off mid' }, finish_reason: "length" }],
    });
  }
  json(res, 200, { choices: [{ message: { content } }] });
});

gh.listen(GH_PORT, () => console.log(`mock-github on ${GH_PORT}`));
or.listen(OR_PORT, () => console.log(`mock-openrouter on ${OR_PORT}`));
