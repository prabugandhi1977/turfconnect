// Demo data: an admin, a venue owner with staff, players, six venues (one awaiting verification) and ~6 weeks of
// booking history so reports, reviews and payouts have something to show. Run: npm run seed [-- --reset]
import { rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--reset')) {
  // Resolved the same way as db.js, but before it is imported (importing it opens the database).
  const dataDir = process.env.TURF_DATA_DIR || join(dirname(dirname(fileURLToPath(import.meta.url))), 'data');
  const file = process.env.TURF_DB || join(dataDir, 'turfconnect.sqlite');
  for (const f of [file, file + '-wal', file + '-shm']) if (existsSync(f)) rmSync(f);
  console.log('Database reset.');
}
const { seedDemo } = await import('./demo-data.js');
console.log(seedDemo());
