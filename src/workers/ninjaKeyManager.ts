export interface NinjaKeyManager {
  acquireKey(): Promise<string | null>;
  releaseKey(key: string): Promise<void>;
  markError(key: string): Promise<void>;
}

export class SimpleNinjaKeyManager implements NinjaKeyManager {
  private keys: string[];
  private inUse: Set<string> = new Set();

  constructor(keys: string[]) {
    this.keys = keys;
  }

  async acquireKey(): Promise<string | null> {
    const key = this.keys.find(k => !this.inUse.has(k));
    if (!key) return null;
    this.inUse.add(key);
    return key;
  }

  async releaseKey(key: string) {
    this.inUse.delete(key);
  }

  async markError(key: string) {
    // scaffold: release immediately; real impl could cooldown
    this.inUse.delete(key);
  }
}