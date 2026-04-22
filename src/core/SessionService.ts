import type { BridgeSession } from "../session/types.js";
import type { SessionStatus, SessionStorePort } from "./types.js";

export class SessionService {
  constructor(private readonly store: SessionStorePort) {}

  async save(session: BridgeSession): Promise<void> {
    await this.store.save(session);
  }

  async clear(session: BridgeSession, userId = session.userId): Promise<BridgeSession> {
    const next = await this.store.clear(userId, {
      cwd: session.cwd,
      allowlistRoots: session.allowlistRoots,
    });
    Object.assign(session, next);
    return session;
  }

  addHistory(session: BridgeSession, role: "user" | "assistant", content: string): void {
    this.store.addHistory(session, role, content);
  }

  history(session: BridgeSession, limit?: number): string {
    return this.store.formatHistory(session, limit);
  }

  status(session: BridgeSession, boundUserId: string): SessionStatus {
    return {
      userId: session.userId,
      boundUserId,
      state: session.state,
      cwd: session.cwd,
      allowlistRoots: session.allowlistRoots,
      mode: session.mode,
      model: session.model,
      codexSessionId: session.codexSessionId,
      codexThreadId: session.codexThreadId,
      activeTurnId: session.activeTurnId,
      historyCount: session.history.length,
      updatedAt: session.updatedAt,
    };
  }
}
