export interface NinjaKeyManager {
  acquireKey(): Promise<string | null>;
  releaseKey(key: string): Promise<void>;
  markError(key: string): Promise<void>;
}

type KeyState = {
  lastUsed: number;
  cooldownUntil?: number;
};

export class RotatingNinjaKeyManager implements NinjaKeyManager {
  private keys: string[];
  private inUse: Set<string> = new Set();
  private state: Map<string, KeyState> = new Map();
  private cooldownMs: number;

  constructor(keys: string[], cooldownMs = 10_000) {
    this.keys = keys.filter(Boolean);
    this.cooldownMs = cooldownMs;
    for (const k of this.keys) this.state.set(k, { lastUsed: 0 });
  }

  async acquireKey(): Promise<string | null> {
    const now = Date.now();
    const candidates = this.keys.filter(k => !this.inUse.has(k));
    if (candidates.length === 0) return null;
    // Prefer keys not in cooldown, then least recently used
    const sorted = candidates.sort((a, b) => {
      const sa = this.state.get(a)!;
      const sb = this.state.get(b)!;
      const ca = sa.cooldownUntil && sa.cooldownUntil > now ? 1 : 0;
      const cb = sb.cooldownUntil && sb.cooldownUntil > now ? 1 : 0;
      if (ca !== cb) return ca - cb;
      return sa.lastUsed - sb.lastUsed;
    });
    const key = sorted[0];
    const s = this.state.get(key)!;
    if (s.cooldownUntil && s.cooldownUntil > now) {
      // if all are cooling down, return null
      const anyActive = sorted.some(k => {
        const st = this.state.get(k)!;
        return !st.cooldownUntil || st.cooldownUntil <= now;
      });
      if (!anyActive) return null;
    }
    this.inUse.add(key);
    this.state.set(key, { ...s, lastUsed: now });
    return key;
  }

  async releaseKey(key: string) {
    this.inUse.delete(key);
  }

  async markError(key: string) {
    const now = Date.now();
    const s = this.state.get(key) || { lastUsed: now };
    this.state.set(key, { ...s, cooldownUntil: now + this.cooldownMs });
    this.inUse.delete(key);
  }
}