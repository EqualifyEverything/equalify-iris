import { readFileSync } from "node:fs";

// Which build is running, for `GET /v1/health` to report.
//
// The deployment already answers this question once, at boot: `server.base_url` exists only to
// be printed there, and config.example.yaml says why — "so you can check the running process is
// the one you meant to deploy". That answer is only available to whoever can read the
// container's stdout. An operator standing outside the box has the liveness probe and nothing
// else, so the same check goes there.
//
// Read from package.json rather than written down a second time. A version stated twice is one
// that eventually disagrees with itself, and the release step edits `package.json` — so a
// constant here would be the copy that goes stale on the one commit that matters.

const PACKAGE_JSON = new URL("../../package.json", import.meta.url);

/**
 * This build's version string, or `null` where it could not be read.
 *
 * `null` rather than `"unknown"` or `"0.0.0"`: the field is then always present, so the response
 * shape does not depend on the filesystem, and a null says the build cannot name itself instead
 * of naming a version an operator would go looking for. `GET /v1/limits` answers
 * `rate_limits: null` on the same reasoning.
 *
 * Nothing here may throw. The caller is a liveness probe, and a service that reports itself DOWN
 * because it could not find its own package.json is a worse answer than one that reports up
 * without a version.
 */
export function readVersion(from: URL): string | null {
  try {
    const parsed = JSON.parse(readFileSync(from, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
  } catch {
    return null;
  }
}

// Once, at import. Config does not hot-reload in v1 and neither does the file on disk that this
// process was started from, so there is nothing here that can change between requests.
export const SERVICE_VERSION: string | null = readVersion(PACKAGE_JSON);
