// Captures what the current converter produces for the v1 fixture. Run once
// on the released converter; the tests compare against the saved output.
import { writeFileSync } from 'fs';
import { convert, v1Fixture } from './fixtures.js';
import { readWpilog } from './helpers.js';

const out = await convert(v1Fixture());
const { values } = readWpilog(out);
writeFileSync(
  new URL('./fixtures/v1-baseline.json', import.meta.url),
  JSON.stringify(
    values.map((v) => ({
      name: v.name,
      type: v.type,
      timestampUs: v.timestampUs.toString(),
      value: typeof v.value === 'bigint' ? v.value.toString() : v.value,
    })),
    null,
    1
  ) + '\n'
);
console.log(`captured ${values.length} values`);
