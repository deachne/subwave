// Disk-backed retry spool for post-air events. One fsynced file per event keeps
// an already-aired fact durable when the JSONL ledger is temporarily blocked.

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { config } from '../../config.js';
import {
  assertDurableDirectory,
  readDurableRegularFile,
  removeDurableFile,
  writeDurableFileExclusive,
} from '../../util/durable-file.js';
import {
  appendLedgerEvent,
  commitVoiceAuditEventToSink,
  readLedgerEvents,
  refreshVoiceAuditEventIndexSink,
  removeVoiceAuditEventIndexSink,
} from './ledger.js';
import {
  voiceAuditEventSchema,
  type VoiceAuditEvent,
} from './types.js';
import {
  latchVoiceAuditUnhealthy,
  logVoiceAuditError,
  redactVoiceAuditError,
} from './health.js';

const SPOOL_FILE_RE = /^\d{16}-[a-f0-9]{32}\.json$/;
let spoolTail: Promise<void> = Promise.resolve();

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function withSpoolStorage<T>(fn: () => Promise<T>): Promise<T> {
  const run = spoolTail.catch(() => undefined).then(fn);
  spoolTail = run.then(() => undefined, () => undefined);
  return run;
}

function spoolName(event: VoiceAuditEvent): string {
  const id = createHash('sha256').update(event.eventId).digest('hex').slice(0, 32);
  return `${String(event.atMs).padStart(16, '0')}-${id}.json`;
}

async function spoolNames(): Promise<string[]> {
  try {
    await assertDurableDirectory(config.voiceAudit.spoolDir);
    return (await readdir(config.voiceAudit.spoolDir))
      .filter((name) => SPOOL_FILE_RE.test(name))
      .sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readSpoolFile(name: string): Promise<VoiceAuditEvent> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      (await readDurableRegularFile(`${config.voiceAudit.spoolDir}/${name}`))
        .toString('utf8'),
    );
  } catch {
    throw new Error(`invalid voice audit spool JSON: ${name}`);
  }
  const result = voiceAuditEventSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid voice audit spool event ${name}: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  if (spoolName(result.data) !== name) {
    throw new Error(`voice audit spool filename does not match its event: ${name}`);
  }
  return result.data;
}

async function writeSpoolEventUnlocked(input: unknown): Promise<VoiceAuditEvent> {
  // Validate before the exclusive durable writer gets a chance to create the spool
  // directory. Invalid events never reach either durable sink.
  const event = voiceAuditEventSchema.parse(input);
  const path = `${config.voiceAudit.spoolDir}/${spoolName(event)}`;
  const body = JSON.stringify(event);
  try {
    await commitVoiceAuditEventToSink(event, 'spool', async () => {
      try {
        await writeDurableFileExclusive(path, body);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          const existing = await readSpoolFile(spoolName(event));
          if (JSON.stringify(existing) === body) return;
        } catch {
          // Report the collision below; malformed existing evidence is never
          // replaced by a new event.
        }
        throw new Error(`voice audit spool eventId collision: ${event.eventId}`);
      }
    });
  } catch (err: unknown) {
    if (errorMessage(err, '').includes('eventId collision')) {
      const message = `voice audit spool eventId collision: ${event.eventId}`;
      await latchVoiceAuditUnhealthy(message);
      throw new Error(message);
    }
    throw err;
  }
  return event;
}

export function writeSpoolEvent(input: unknown): Promise<VoiceAuditEvent> {
  return withSpoolStorage(() => writeSpoolEventUnlocked(input));
}

export type PostAirAuditResult =
  | { ok: true; sink: 'ledger' | 'spool' }
  | { ok: false; message: string };

export async function appendPostAir(input: unknown): Promise<PostAirAuditResult> {
  let event: VoiceAuditEvent;
  try {
    // Parse once before either sink can create a path.
    event = voiceAuditEventSchema.parse(input);
  } catch (err: unknown) {
    const message = redactVoiceAuditError(
      `invalid post-air voice audit event: ${errorMessage(err, 'schema mismatch')}`,
    );
    await latchVoiceAuditUnhealthy(message);
    logVoiceAuditError(message);
    return { ok: false, message };
  }
  try {
    await appendLedgerEvent(event);
    return { ok: true, sink: 'ledger' };
  } catch (ledgerError: unknown) {
    try {
      await writeSpoolEvent(event);
      return { ok: true, sink: 'spool' };
    } catch (spoolError: unknown) {
      const message = redactVoiceAuditError(
        `post-air voice audit lost durable sinks; ledger: ${
          errorMessage(ledgerError, 'failed')
        }; spool: ${errorMessage(spoolError, 'failed')}`,
      );
      await latchVoiceAuditUnhealthy(message);
      logVoiceAuditError(message);
      return { ok: false, message };
    }
  }
}

async function readSpoolEventsUnlocked(): Promise<VoiceAuditEvent[]> {
  const events: VoiceAuditEvent[] = [];
  for (const name of await spoolNames()) events.push(await readSpoolFile(name));
  return events;
}

export function readSpoolEvents(): Promise<VoiceAuditEvent[]> {
  return withSpoolStorage(async () => {
    const events = await readSpoolEventsUnlocked();
    await refreshVoiceAuditEventIndexSink('spool', events);
    return events;
  });
}

export function readLedgerAndSpoolEvents(): Promise<VoiceAuditEvent[]> {
  return withSpoolStorage(async () => {
    const ledger = await readLedgerEvents();
    const spool = await readSpoolEventsUnlocked();
    await refreshVoiceAuditEventIndexSink('spool', spool);
    return [...ledger, ...spool];
  });
}

export async function drainVoiceAuditSpool(): Promise<{
  drained: number;
  remaining: number;
}> {
  return withSpoolStorage(async () => {
    const names = await spoolNames();
    if (names.length === 0) {
      await refreshVoiceAuditEventIndexSink('spool', []);
      return { drained: 0, remaining: 0 };
    }
    const persisted = new Map<string, string>();
    for (const event of await readLedgerEvents()) {
      const body = JSON.stringify(event);
      const prior = persisted.get(event.eventId);
      if (prior && prior !== body) {
        throw new Error(`voice audit eventId collision in ledger: ${event.eventId}`);
      }
      persisted.set(event.eventId, body);
    }
    let drained = 0;
    // Stop at the first failure. Lexical names are timestamp ordered, so a later
    // event can never leapfrog a blocked/corrupt earlier record.
    for (const name of names) {
      const event = await readSpoolFile(name);
      const body = JSON.stringify(event);
      const prior = persisted.get(event.eventId);
      if (prior && prior !== body) {
        throw new Error(`voice audit eventId collision between ledger and spool: ${event.eventId}`);
      }
      if (!prior) {
        await appendLedgerEvent(event);
        persisted.set(event.eventId, body);
      }
      await removeDurableFile(`${config.voiceAudit.spoolDir}/${name}`);
      await removeVoiceAuditEventIndexSink(event.eventId, 'spool');
      drained += 1;
    }
    return { drained, remaining: names.length - drained };
  });
}

export function resetVoiceAuditSpoolForTests(): void {
  spoolTail = Promise.resolve();
}
