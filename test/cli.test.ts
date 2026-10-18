import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";

const ROOT = join(import.meta.dirname, "..");
const CLI_PATH = join(ROOT, "src", "cli.ts");

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      status: e.status ?? 1,
    };
  }
}

test("cli --help outputs usage and WCAG claim", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.ok(res.stdout.includes("Equalify Iris CLI"));
  assert.ok(res.stdout.includes("WCAG 2.2 AA"));
  assert.ok(res.stdout.includes("-i, --input"));
  assert.ok(res.stdout.includes("-o, --output"));
  assert.ok(res.stdout.includes("-c, --config"));
});

test("cli without arguments exits with code 1 and prints error", () => {
  const res = runCli([]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes("Error: No input file specified."));
});

test("cli with non-existent file exits with code 1", () => {
  const res = runCli(["non_existent_file_12345.pdf"]);
  assert.equal(res.status, 1);
  assert.ok(res.stderr.includes("Error: Input file not found"));
});

test("cli rejects unsupported file types", () => {
  const tmpFile = join(ROOT, "tmp_test_unsupported.txt");
  writeFileSync(tmpFile, "dummy content");
  try {
    const res = runCli([tmpFile]);
    assert.equal(res.status, 1);
    assert.ok(res.stderr.includes("Error: Unsupported file type: tmp_test_unsupported.txt (allowed: PNG,"), res.stderr);
  } finally {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  }
});

test("the CLI and the upload route stage a session through the same code", () => {
  for (const file of [["src", "cli.ts"], ["src", "routes", "sessions.ts"]]) {
    const src = readFileSync(join(ROOT, ...file), "utf8");
    assert.match(src, /await renderUploads\(files, imageLimits\)/, file.join("/"));
    assert.match(src, /await stageSession\(cfg, store, paths, files, rendered\.pages, rendered\.refits\)/, file.join("/"));
    assert.doesNotMatch(src, /rasterizePdf\(|store\.createSession\(/, file.join("/"));
  }
});
