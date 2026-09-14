import { readFileSync } from "node:fs";

// The running build's version, read from package.json.
//
// It exists so a deployed container can say which build it is from OUTSIDE the box, which is
// where an operator stands. `server.base_url` already answers that question from the inside —
// config.example.yaml says its only purpose is "so you can check the running process is the
// one you meant to deploy" — and a probe that already returns 200 can carry the same fact for
// nothing.
//
// package.json is the single place the version is written (the only other copy is
// package-lock.json, which npm keeps in step), so nothing here can disagree with the release
// tag. Read once at import rather than per request: it cannot change under a running process,
// and a liveness probe should not touch the filesystem.
export const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;
