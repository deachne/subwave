// Fourteen-day retention for ordinary voice-audit day files. Golden evidence
// lives under its own directory and is intentionally outside this sweep.

import { readdir } from 'node:fs/promises';
import { config } from '../../config.js';
import {
  assertDurableDirectory,
  removeDurableFile,
} from '../../util/durable-file.js';
import {
  invalidateVoiceAuditEventIndex,
  withVoiceAuditLedgerStorage,
} from './ledger.js';
import { withActiveRollingReservations } from './rolling-policy.js';

export const VOICE_AUDIT_RETENTION_DAYS = 14;
const EVENT_FILE_RE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const TORN_FILE_RE =
  /^torn-events-(\d{4}-\d{2}-\d{2})\.jsonl-[a-f0-9]{64}\.fragment$/;

export async function pruneVoiceAuditEvents(
  nowMs = Date.now(),
  maxAgeDays = VOICE_AUDIT_RETENTION_DAYS,
): Promise<number> {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;
  return withActiveRollingReservations((reservations) =>
    withVoiceAuditLedgerStorage(async () => {
      const protectedDays = new Set(reservations.map((reservation) =>
        new Date(reservation.createdAtMs).toISOString().slice(0, 10)));
      let names: string[];
      try {
        await assertDurableDirectory(config.voiceAudit.dir);
        names = await readdir(config.voiceAudit.dir);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
        throw err;
      }
      const cutoff =
        new Date(nowMs - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
      let removed = 0;
      const failures: string[] = [];
      for (const name of names) {
        const day =
          name.match(EVENT_FILE_RE)?.[1] ?? name.match(TORN_FILE_RE)?.[1];
        if (!day || day >= cutoff || protectedDays.has(day)) continue;
        try {
          await removeDurableFile(`${config.voiceAudit.dir}/${name}`);
          removed += 1;
        } catch {
          // One damaged/locked day must not prevent attempts on the rest.
          failures.push(name);
        }
      }
      if (removed > 0) await invalidateVoiceAuditEventIndex();
      if (failures.length) {
        throw new Error(
          `voice audit retention removed ${removed} file(s), but failed: ${failures.join(', ')}`,
        );
      }
      return removed;
    }));
}
