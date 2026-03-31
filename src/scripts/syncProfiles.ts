import { syncProfiles } from '../utils/syncUtils';

async function run() {
  try {
    const total = await syncProfiles();
    console.log(`Synced ${total} profiles`);
    process.exit(0);
  } catch (e) {
    console.error('syncProfiles failed:', e);
    process.exit(1);
  }
}

run();