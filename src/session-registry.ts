import { McpToolError } from "./tool-result.js";
import { SshSession, type ConnectInput, type SessionSummary } from "./ssh-session.js";

export class SessionRegistry {
  private readonly sessions = new Map<string, SshSession>();

  public async connect(input: ConnectInput): Promise<SessionSummary> {
    const session = await SshSession.connect(input);
    this.sessions.set(session.id, session);
    return session.summary();
  }

  public get(sessionId: string): SshSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new McpToolError("ssh_session_not_found", "SSH session id was not found", { sessionId });
    }
    return session;
  }

  public list(): SessionSummary[] {
    return [...this.sessions.values()].map((session) => session.summary());
  }

  public async disconnect(sessionId: string): Promise<SessionSummary> {
    const session = this.get(sessionId);
    const summary = await session.disconnect();
    this.sessions.delete(sessionId);
    return summary;
  }

  public async disconnectAll(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const session of this.sessions.values()) {
      summaries.push(await session.disconnect());
    }
    this.sessions.clear();
    return summaries;
  }
}
