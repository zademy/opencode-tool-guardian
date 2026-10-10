import type { SessionState } from "../core/models.js";
import { newSessionState } from "../core/models.js";

export interface StoreOptions {
  readonly maxSessions: number;
  readonly ttlMs: number;
  readonly now?: () => number;
}

/**
 * Bounded per-session store. LRU eviction plus TTL, keyed by session id so metrics
 * are never shared across sessions, users or projects.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: StoreOptions) {
    this.maxSessions = options.maxSessions;
    this.ttlMs = options.ttlMs;
    this.now = options.now ?? (() => Date.now());
  }

  get(sessionId: string): SessionState {
    this.evictExpired();
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, existing);
      return existing;
    }
    const created = newSessionState(sessionId, this.now());
    this.sessions.set(sessionId, created);
    this.trim();
    return created;
  }

  /** Peeks without creating, for callers that must not allocate state. */
  peek(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  delete(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  clear(): void {
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  private evictExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, state] of this.sessions) {
      if (state.createdAt < cutoff) this.sessions.delete(id);
    }
  }

  private trim(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
  }
}
