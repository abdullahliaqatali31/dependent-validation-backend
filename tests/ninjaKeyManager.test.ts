import { RotatingNinjaKeyManager } from '../src/utils/ninjaKeyManager';

describe('RotatingNinjaKeyManager', () => {
  test('acquires and releases keys in rotation', async () => {
    const mgr = new RotatingNinjaKeyManager(['A', 'B', 'C'], 100);
    const k1 = await mgr.acquireKey();
    const k2 = await mgr.acquireKey();
    const k3 = await mgr.acquireKey();
    const k4 = await mgr.acquireKey();
    expect([k1, k2, k3].sort()).toEqual(['A', 'B', 'C']);
    expect(k4).toBeNull();
    await mgr.releaseKey(k1!);
    const k5 = await mgr.acquireKey();
    expect(k5).toBe(k1);
  });

  test('cooldown on error prevents immediate reuse', async () => {
    const mgr = new RotatingNinjaKeyManager(['A'], 200);
    const k = await mgr.acquireKey();
    expect(k).toBe('A');
    await mgr.markError('A');
    const k2 = await mgr.acquireKey();
    expect(k2).toBeNull();
    await new Promise(r => setTimeout(r, 210));
    const k3 = await mgr.acquireKey();
    expect(k3).toBe('A');
  });
});