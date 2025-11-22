import { config } from '../config';
import { SimpleNinjaKeyManager } from '../utils/simpleNinjaKeyManager';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function verify(email: string, key: string) {
  const url = `https://happy.mailtester.ninja/ninja?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}`;
  const resp = await fetch(url);
  const data = await resp.json().catch(async () => ({ code: 'error', message: await resp.text() }));
  return { status: resp.status, body: data };
}

async function main() {
  if (!config.ninjaKeys.length) {
    console.error('No NINJA_KEYS configured.');
    process.exit(1);
  }
  const emails = [
    'admin@example.com',
    'sales@stripe.com',
    'test@openai.com',
    'invalid@nonexistent.tld',
    'support@microsoft.com'
  ];
  const km = new SimpleNinjaKeyManager(config.ninjaKeys, config.ninjaRateLimit, config.ninjaIntervalMs);
  console.log('Testing Ninja with keys:', config.ninjaKeys.length);
  for (const e of emails) {
    const key = await km.getAvailableKey();
    try {
      await sleep(config.ninjaDelayMs);
      const res = await verify(e, key);
      console.log(e, '→', JSON.stringify(res.body));
    } catch (err) {
      console.error(e, '→ error', (err as any)?.message || String(err));
    } finally {
      await km.releaseKey(key);
    }
  }
  console.log('Done.');
  process.exit(0);
}

main();