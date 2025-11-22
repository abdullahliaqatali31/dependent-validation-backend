import { isUnsubscribed, isUnsubscribedEmail, isUnsubscribedDomain } from '../src/utils/unsubscribeFilter';

jest.mock('../src/db', () => ({
  query: async (sql: string, params: any[]) => {
    const email = params[0];
    if (sql.includes('unsubscribe_list')) {
      return { rows: email === 'leave@company.com' ? [{ email }] : [] };
    }
    if (sql.includes('unsubscribe_domains')) {
      return { rows: email === 'blocked.com' ? [{ domain: email }] : [] };
    }
    return { rows: [] };
  }
}));

describe('unsubscribeFilter', () => {
  test('detects unsubscribed emails', async () => {
    expect(await isUnsubscribedEmail('leave@company.com')).toBe(true);
    expect(await isUnsubscribedEmail('stay@company.com')).toBe(false);
  });
  test('detects unsubscribed domains', async () => {
    expect(await isUnsubscribedDomain('blocked.com')).toBe(true);
    expect(await isUnsubscribedDomain('ok.com')).toBe(false);
  });
  test('isUnsubscribed combines checks', async () => {
    expect(await isUnsubscribed('stay@company.com', 'blocked.com')).toBe(true);
    expect(await isUnsubscribed('leave@company.com', 'ok.com')).toBe(true);
    expect(await isUnsubscribed('keep@ok.com', 'ok.com')).toBe(false);
  });
});