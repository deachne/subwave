// Pin one measured final-bus hour and its correlated voice evidence.
//
//   npx tsx scripts/pin-golden-hour.ts \
//     --hour 2026-11-01T01-0500@America_Winnipeg \
//     --archive /path/to/hour.mp3 \
//     --measurements /path/to/measurements.json

import {
  goldenMeasurementsSchema,
  pinGoldenHour,
} from '../src/broadcast/voice-audit/golden.js';
import { readDurableRegularFile } from '../src/util/durable-file.js';

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (!value || value.startsWith('--')) throw new Error(`missing ${name}`);
  return value;
}

async function measurementsFrom(value: string): Promise<unknown> {
  if (value.trim().startsWith('{')) return JSON.parse(value);
  return JSON.parse((await readDurableRegularFile(value)).toString('utf8'));
}

try {
  const hour = option('--hour');
  const archivePath = option('--archive');
  const measurements = goldenMeasurementsSchema.parse(
    await measurementsFrom(option('--measurements')),
  );
  const result = await pinGoldenHour({
    hour,
    archivePath,
    measurements,
  });
  console.log(`Pinned ${result.manifest.stationHourKey} at ${result.directory}`);
} catch (err: unknown) {
  console.error(`pin-golden-hour: ${err instanceof Error ? err.message : 'failed'}`);
  process.exitCode = 1;
}
