// Append-only, fsynced JSONL ledger for rendered-voice evidence.

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { config } from '../../config.js';
import {
  appendDurableFile,
  assertDurableDirectory,
  readDurableRegularFile,
  removeDurableFile,
  truncateDurableFile,
  withDurableRegularFile,
  writeDurableFileExclusive,
} from '../../util/durable-file.js';
import {
  voiceAuditEventSchema,
  type VoiceAuditEvent,
} from './types.js';
import {
  automaticVoiceAuditAdmission,
  automaticVoiceAuditAdmissionStillValid,
  latchVoiceAuditUnhealthy,
  logVoiceAuditError,
  redactVoiceAuditError,
} from './health.js';

let ledgerTail: Promise<void> = Promise.resolve();
let eventIndexTail: Promise<void> = Promise.resolve();
const EVENT_FILE_RE = /^events-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const SPOOL_FILE_RE = /^\d{16}-[a-f0-9]{32}\.json$/;
type VoiceAuditSink = 'ledger' | 'spool';
interface IndexedVoiceAuditEvent {
  body: string;
  sinks: Set<VoiceAuditSink>;
}
let eventIndex: Map<string, IndexedVoiceAuditEvent> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

export function voiceAuditEventPath(atMs: number): string {
  const day = new Date(atMs).toISOString().slice(0, 10);
  return `${config.voiceAudit.eventsPrefix}${day}.jsonl`;
}

async function quarantineTornLedgerTail(path: string, body: Buffer): Promise<never> {
  const finalNewline = body.lastIndexOf(0x0a);
  const intactSize = finalNewline === -1 ? 0 : finalNewline + 1;
  const tornTail = body.subarray(intactSize);
  const tailHash = createHash('sha256').update(tornTail).digest('hex');
  const quarantinePath = join(
    dirname(path),
    `torn-${basename(path)}-${tailHash}.fragment`,
  );
  try {
    await writeDurableFileExclusive(quarantinePath, tornTail);
  } catch (err: unknown) {
    if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
    const existing = await readDurableRegularFile(quarantinePath);
    if (!existing.equals(tornTail)) {
      throw new Error(`torn audit quarantine collision at ${basename(quarantinePath)}`);
    }
  }
  await truncateDurableFile(path, intactSize);
  throw new Error(`quarantined torn final audit record from ${basename(path)}`);
}

function serializeLedgerEvent(input: unknown): {
  event: VoiceAuditEvent;
  line: string;
} {
  const event = voiceAuditEventSchema.parse(input);
  return { event, line: `${JSON.stringify(event)}\n` };
}

export function withVoiceAuditLedgerStorage<T>(fn: () => Promise<T>): Promise<T> {
  const run = ledgerTail.catch(() => undefined).then(fn);
  ledgerTail = run.then(() => undefined, () => undefined);
  return run;
}

function withVoiceAuditEventIndex<T>(fn: () => Promise<T>): Promise<T> {
  const run = eventIndexTail.catch(() => undefined).then(fn);
  eventIndexTail = run.then(() => undefined, () => undefined);
  return run;
}

function addIndexedEvent(
  index: Map<string, IndexedVoiceAuditEvent>,
  event: VoiceAuditEvent,
  sink: VoiceAuditSink,
): void {
  const body = JSON.stringify(event);
  const existing = index.get(event.eventId);
  if (existing && existing.body !== body) {
    throw new Error(`voice audit eventId collision: ${event.eventId}`);
  }
  if (existing) existing.sinks.add(sink);
  else index.set(event.eventId, { body, sinks: new Set([sink]) });
}

function spoolFileName(event: VoiceAuditEvent): string {
  const id = createHash('sha256').update(event.eventId).digest('hex').slice(0, 32);
  return `${String(event.atMs).padStart(16, '0')}-${id}.json`;
}

async function readIndexedSpoolEvents(): Promise<VoiceAuditEvent[]> {
  let names: string[];
  try {
    await assertDurableDirectory(config.voiceAudit.spoolDir);
    names = await readdir(config.voiceAudit.spoolDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const events: VoiceAuditEvent[] = [];
  for (const name of names.filter((entry) => SPOOL_FILE_RE.test(entry)).sort()) {
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
    if (!result.success || spoolFileName(result.data) !== name) {
      throw new Error(`invalid voice audit spool event: ${name}`);
    }
    events.push(result.data);
  }
  return events;
}

async function loadVoiceAuditEventIndex(
  { tolerateLedgerFailure = false }: { tolerateLedgerFailure?: boolean } = {},
): Promise<{
  index: Map<string, IndexedVoiceAuditEvent>;
  complete: boolean;
}> {
  const index = new Map<string, IndexedVoiceAuditEvent>();
  let complete = true;
  let ledgerEvents: VoiceAuditEvent[] = [];
  try {
    ledgerEvents = await readLedgerEventsUnlocked();
  } catch (err) {
    if (!tolerateLedgerFailure) throw err;
    complete = false;
  }
  for (const event of ledgerEvents) {
    addIndexedEvent(index, event, 'ledger');
  }
  for (const event of await readIndexedSpoolEvents()) {
    addIndexedEvent(index, event, 'spool');
  }
  return { index, complete };
}

export function commitVoiceAuditEventToSink(
  event: VoiceAuditEvent,
  sink: VoiceAuditSink,
  write: () => Promise<void>,
): Promise<boolean> {
  return withVoiceAuditEventIndex(async () => {
    let index = eventIndex;
    let cacheIndex = true;
    if (!eventIndex) {
      const loaded = await loadVoiceAuditEventIndex({
        tolerateLedgerFailure: sink === 'spool',
      });
      index = loaded.index;
      cacheIndex = loaded.complete;
      if (cacheIndex) eventIndex = index;
    }
    if (!index) throw new Error('voice audit event index did not initialize');
    const body = JSON.stringify(event);
    const existing = index.get(event.eventId);
    if (existing && existing.body !== body) {
      throw new Error(`voice audit eventId collision: ${event.eventId}`);
    }
    if (existing?.sinks.has(sink)) {
      if (!cacheIndex) eventIndex = null;
      return false;
    }
    try {
      await write();
    } catch (err) {
      eventIndex = null;
      throw err;
    }
    addIndexedEvent(index, event, sink);
    if (!cacheIndex) eventIndex = null;
    return true;
  });
}

export function refreshVoiceAuditEventIndexSink(
  sink: VoiceAuditSink,
  events: readonly VoiceAuditEvent[],
): Promise<void> {
  return withVoiceAuditEventIndex(async () => {
    if (!eventIndex) return;
    for (const [eventId, indexed] of eventIndex) {
      indexed.sinks.delete(sink);
      if (indexed.sinks.size === 0) eventIndex.delete(eventId);
    }
    for (const event of events) addIndexedEvent(eventIndex, event, sink);
  });
}

export function removeVoiceAuditEventIndexSink(
  eventId: string,
  sink: VoiceAuditSink,
): Promise<void> {
  return withVoiceAuditEventIndex(async () => {
    const indexed = eventIndex?.get(eventId);
    if (!indexed) return;
    indexed.sinks.delete(sink);
    if (indexed.sinks.size === 0) eventIndex?.delete(eventId);
  });
}

export function invalidateVoiceAuditEventIndex(): Promise<void> {
  return withVoiceAuditEventIndex(async () => {
    eventIndex = null;
  });
}

export function ensureVoiceAuditEventIndex(): Promise<void> {
  return withVoiceAuditEventIndex(async () => {
    if (!eventIndex) eventIndex = (await loadVoiceAuditEventIndex()).index;
  });
}

async function validateLedgerTail(path: string): Promise<void> {
  let torn = false;
  try {
    torn = await withDurableRegularFile(path, async (handle, target) => {
      if (target.size === 0) return false;
      const finalByte = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(
        finalByte,
        0,
        1,
        target.size - 1,
      );
      return bytesRead !== 1 || finalByte[0] !== 0x0a;
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (torn) {
    const bytes = await readDurableRegularFile(path);
    await quarantineTornLedgerTail(path, bytes);
  }
}

export async function appendLedgerEvent(input: unknown): Promise<VoiceAuditEvent> {
  // Parse before even deriving a filename: an invalid event reaches neither
  // the ledger nor a directory-creation call.
  const { event, line } = serializeLedgerEvent(input);
  const path = voiceAuditEventPath(event.atMs);
  await withVoiceAuditLedgerStorage(async () => {
    await validateLedgerTail(path);
    await commitVoiceAuditEventToSink(
      event,
      'ledger',
      () => appendDurableFile(path, line),
    );
  });
  return event;
}

export type PreAirAuditResult =
  | { ok: true; auditPersisted: true }
  | { ok: true; auditPersisted: false; warning: string }
  | {
      ok: false;
      auditPersisted: false;
      code: 'audit_unavailable';
      stage: 'audit';
      message: string;
    };

export async function appendPreAir(
  input: unknown,
  { automatic }: { automatic: boolean },
): Promise<PreAirAuditResult> {
  const admission = automatic ? await automaticVoiceAuditAdmission() : null;
  if (admission && !admission.allowed) {
    return {
      ok: false,
      auditPersisted: false,
      code: 'audit_unavailable',
      stage: 'audit',
      message: 'voice audit is not ready or unhealthy; automatic speech is disabled',
    };
  }
  try {
    await appendLedgerEvent(input);
    if (
      admission
      && !(await automaticVoiceAuditAdmissionStillValid(admission))
    ) {
      return {
        ok: false,
        auditPersisted: false,
        code: 'audit_unavailable',
        stage: 'audit',
        message: 'voice audit became unavailable during the pre-air commit',
      };
    }
    return { ok: true, auditPersisted: true };
  } catch (err: unknown) {
    const message = redactVoiceAuditError(
      `voice audit write failed: ${errorMessage(err)}`,
    );
    await latchVoiceAuditUnhealthy(message);
    logVoiceAuditError(message);
    if (automatic) {
      return {
        ok: false,
        auditPersisted: false,
        code: 'audit_unavailable',
        stage: 'audit',
        message,
      };
    }
    return {
      ok: true,
      auditPersisted: false,
      warning: `${message}; operator-triggered speech may continue unaudited`,
    };
  }
}

async function readLedgerEventsUnlocked(): Promise<VoiceAuditEvent[]> {
  let names: string[];
  try {
    await assertDurableDirectory(config.voiceAudit.dir);
    names = await readdir(config.voiceAudit.dir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const events: VoiceAuditEvent[] = [];
  const eventBodies = new Map<string, string>();
  for (const name of names.filter((entry) => EVENT_FILE_RE.test(entry)).sort()) {
    const path = `${config.voiceAudit.dir}/${name}`;
    const bytes = await readDurableRegularFile(path);
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
      await quarantineTornLedgerTail(path, bytes);
    }
    const body = bytes.toString('utf8');
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        throw new Error(`invalid voice audit JSON at ${name}:${i + 1}`);
      }
      const result = voiceAuditEventSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`invalid voice audit event at ${name}:${i + 1}: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
      }
      if (basename(voiceAuditEventPath(result.data.atMs)) !== name) {
        throw new Error(`voice audit event stored under the wrong day at ${name}:${i + 1}`);
      }
      const canonicalBody = JSON.stringify(result.data);
      const existingBody = eventBodies.get(result.data.eventId);
      if (existingBody && existingBody !== canonicalBody) {
        throw new Error(`voice audit eventId collision: ${result.data.eventId}`);
      }
      if (existingBody) continue;
      eventBodies.set(result.data.eventId, canonicalBody);
      events.push(result.data);
    }
  }
  return events;
}

export async function readLedgerEvents(): Promise<VoiceAuditEvent[]> {
  return withVoiceAuditLedgerStorage(async () => {
    const events = await readLedgerEventsUnlocked();
    await refreshVoiceAuditEventIndexSink('ledger', events);
    return events;
  });
}

export function removeLedgerEventFile(path: string): Promise<void> {
  return withVoiceAuditLedgerStorage(async () => {
    await removeDurableFile(path);
    await invalidateVoiceAuditEventIndex();
  });
}

export function orderAndDedupeAuditEvents(
  events: readonly VoiceAuditEvent[],
): VoiceAuditEvent[] {
  const byId = new Map<string, VoiceAuditEvent>();
  for (const event of events) {
    const current = byId.get(event.eventId);
    if (current && JSON.stringify(current) !== JSON.stringify(event)) {
      throw new Error(`voice audit eventId collision: ${event.eventId}`);
    }
    if (!current || event.atMs < current.atMs) byId.set(event.eventId, event);
  }
  return [...byId.values()].sort((a, b) =>
    a.atMs - b.atMs || a.eventId.localeCompare(b.eventId, 'en'));
}

export function resetVoiceAuditLedgerForTests(): void {
  ledgerTail = Promise.resolve();
  eventIndexTail = Promise.resolve();
  eventIndex = null;
}
