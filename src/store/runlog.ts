import { appendFileSync } from "node:fs";
import type { AgentSpec } from "../agents/loader.ts";

// Appends structured entries to sessions/<id>/log.jsonl (PRD §7.3). Every agent
// invocation records the agent file's git SHA, or the full file content inline
// when the agent was session-built (no upstream object to pin against).
export class RunLog {
  private logPath: string;
  constructor(logPath: string) {
    this.logPath = logPath;
  }

  private write(entry: Record<string, unknown>): void {
    appendFileSync(this.logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  event(type: string, data: Record<string, unknown> = {}): void {
    this.write({ type, ...data });
  }

  // Records the version-pinning info for an agent call, then the call itself.
  agentCall(args: {
    agent: AgentSpec;
    phase: string;
    image?: string;
    output: string;
  }): void {
    this.write({
      type: "agent_call",
      phase: args.phase,
      agent: args.agent.file,
      image: args.image ?? null,
      capabilities: args.agent.capabilities,
      // Version pinning: SHA for library agents, inline content for built ones.
      agent_sha: args.agent.sha,
      agent_content: args.agent.sessionBuilt ? args.agent.content : null,
      output: args.output,
    });
  }
}
