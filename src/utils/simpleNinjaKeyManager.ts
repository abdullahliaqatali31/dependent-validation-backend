export class SimpleNinjaKeyManager {
  private keys: string[];
  private inUse: Set<string> = new Set();
  private usage: Map<string, { count: number; windowStart: number; cooldownUntil?: number }>; 
  private readonly rateLimit: number;
  private readonly intervalMs: number;

  constructor(keys: string[], rateLimit = 35, interval = 30_000) {
    this.keys = (keys || []).filter(Boolean);
    this.rateLimit = Math.max(1, rateLimit);
    this.intervalMs = Math.max(1000, interval);
    this.usage = new Map();
    const now = Date.now();
    for (const k of this.keys) this.usage.set(k, { count: 0, windowStart: now });
  }

  private isAvailable(key: string, now: number): boolean {
    const u = this.usage.get(key)!;
    // Reset window if elapsed
    if (now - u.windowStart >= this.intervalMs) {
      u.windowStart = now;
      u.count = 0;
      u.cooldownUntil = undefined;
    }
    const cooling = !!u.cooldownUntil && u.cooldownUntil > now;
    const underLimit = u.count < this.rateLimit;
    return !cooling && underLimit && !this.inUse.has(key);
  }

  async getAvailableKey(): Promise<string> {
    if (this.keys.length === 0) throw new Error('no_keys_configured');
    while (true) {
      const now = Date.now();
      // Prefer the least used key in the current window
      const candidates = this.keys
        .filter(k => this.isAvailable(k, now))
        .sort((a, b) => (this.usage.get(a)!.count - this.usage.get(b)!.count));
      if (candidates.length > 0) {
        const key = candidates[0];
        const u = this.usage.get(key)!;
        u.count += 1;
        this.inUse.add(key);
        return key;
      }
      // Compute earliest time any key becomes available
      let nextAt = now + 250; // small fallback sleep
      for (const k of this.keys) {
        const u = this.usage.get(k)!;
        const windowResetAt = u.windowStart + this.intervalMs;
        const cooldownAt = u.cooldownUntil && u.cooldownUntil > now ? u.cooldownUntil : windowResetAt;
        nextAt = Math.min(nextAt, cooldownAt);
      }
      const wait = Math.max(50, nextAt - now);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  async releaseKey(key: string): Promise<void> {
    this.inUse.delete(key);
  }

  async markCooldown(key: string): Promise<void> {
    const u = this.usage.get(key);
    if (!u) return;
    u.cooldownUntil = Date.now() + this.intervalMs;
    this.inUse.delete(key);
  }
}