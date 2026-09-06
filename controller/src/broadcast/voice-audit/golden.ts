// Immutable golden-hour evidence bundle. The command stays deliberately
// unusable until a mixer advertises correlated measured voice-end support.

import { createHash, randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import { z } from 'zod';
import { config } from '../../config.js';
import { normalizeBroadcastQa } from '../../settings/normalize.js';
import { getStationTimezone, stationHourKey } from '../../time.js';
import { canonicalSha256 } from '../../util/canonical-json.js';
import {
  assertDurableDirectory,
  copyDurableFileAtomic,
  ensureDurableDirectory,
  makeDurableDirectoryReadOnly,
  makeDurableDirectoryWritable,
  makeDurableFileReadOnly,
  readDurableRegularFile,
  syncDurableDirectory,
  withDurableRegularFile,
  writeDurableFileAtomic,
  writeDurableFileExclusive,
} from '../../util/durable-file.js';
import { realStatePath, resolveStatePath } from '../../util/state-path.js';
import { orderAndDedupeAuditEvents } from './ledger.js';
import { readLedgerAndSpoolEvents } from './spool.js';
import { redactVoiceAuditError } from './health.js';
import {
  auditStringPrivacyIssue,
  isCredentialQueryKey,
  isSensitiveCredentialName,
  stationHourKeySchema,
  type VoiceAuditEvent,
} from './types.js';

const strictIsoTimestampSchema = z.string().max(128).refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value;
}, { message: 'must be a canonical UTC ISO timestamp' });

export const goldenMeasurementsSchema = z.object({
  schemaVersion: z.literal(1),
  stationHourKey: stationHourKeySchema,
  archiveStartedAtMs: z.number().int().nonnegative(),
  archiveEndedAtMs: z.number().int().positive(),
  archiveDurationMs: z.number().int().positive(),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  integratedLufs: z.number(),
  truePeakDbtp: z.number(),
  measuredAt: strictIsoTimestampSchema,
  tool: z.string().min(1).max(256),
}).strict().superRefine((measurements, ctx) => {
  if (
    measurements.archiveEndedAtMs - measurements.archiveStartedAtMs
    !== measurements.archiveDurationMs
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['archiveDurationMs'],
      message: 'archive duration does not match its measured boundaries',
    });
  }
});
export type GoldenMeasurements = z.infer<typeof goldenMeasurementsSchema>;

// Start/end and decoded-artifact durations are independently rounded to
// integer milliseconds; two rounded boundaries can differ by at most 2 ms.
export const GOLDEN_MARKER_TOLERANCE_MS = 2;
const STALE_GOLDEN_STAGING_MS = 24 * 60 * 60 * 1_000;
const LEGACY_GOLDEN_STAGING_RE =
  /^\.\d{4}-\d{2}-\d{2}T\d{2}[+-]\d{4}@[A-Za-z0-9_.+-]+\.[a-f0-9]{12}\.tmp$/;
const GOLDEN_STAGING_RE =
  /^\.\d{4}-\d{2}-\d{2}T\d{2}[+-]\d{4}@[A-Za-z0-9_.+-]+\.(\d+)\.[a-f0-9]{12}\.tmp$/;

const mixerFeatureCapabilitySchema = z.object({
  supported: z.boolean(),
  active: z.boolean(),
}).strict();

const goldenMixerCapabilitiesSchema = z.object({
  schemaVersion: z.literal(1),
  mixerBootTime: z.number().nonnegative(),
  bootSettings: z.object({
    voiceBreaksEnabled: z.boolean(),
  }).strict(),
  features: z.object({
    correlatedVoiceEnd: mixerFeatureCapabilitySchema,
    voicePendingLatch: mixerFeatureCapabilitySchema,
    atomicBreakBatch: mixerFeatureCapabilitySchema,
    breakStartEnd: mixerFeatureCapabilitySchema,
    playoutCompletion: mixerFeatureCapabilitySchema,
  }).strict(),
}).strict();

async function sha256File(
  path: string,
  { requireReadOnly = false }: { requireReadOnly?: boolean } = {},
): Promise<string> {
  return withDurableRegularFile(path, async (handle, before) => {
    if (requireReadOnly && (before.mode & 0o222) !== 0) {
      throw new Error(`voice artifact must be read-only before pinning: ${path}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
    }
    const after = await handle.stat();
    if (
      after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`golden evidence source changed while hashing: ${path}`);
    }
    return hash.digest('hex');
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

const FREEFORM_SECRET_CONTAINER =
  /(?:compatParams|headers?|params?)$/i;

function snapshotFreeformValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshotFreeformValues);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        childKey === 'key' || childKey === 'name'
          ? snapshotValue(child, childKey)
          : snapshotFreeformValues(child),
      ]),
    );
  }
  return value ? 'set' : '';
}

function snapshotValue(value: unknown, key = ''): unknown {
  if (isSensitiveCredentialName(key)) return value ? 'set' : '';
  if (FREEFORM_SECRET_CONTAINER.test(key)) return snapshotFreeformValues(value);
  if (typeof value === 'string') {
    const issue = auditStringPrivacyIssue(value);
    if (issue === 'absolute host path') return '<redacted-path>';
    if (issue) return '<redacted-signed-url>';
    return value;
  }
  if (
    value === null
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => snapshotValue(item, key));
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const semanticKey = typeof rec.key === 'string'
      ? rec.key
      : typeof rec.name === 'string' ? rec.name : '';
    return Object.fromEntries(
      Object.entries(rec).map(([childKey, child]) => [
        childKey,
        childKey === 'value'
          && (
            isSensitiveCredentialName(semanticKey)
            || isCredentialQueryKey(semanticKey)
          )
          ? (child ? 'set' : '')
          : snapshotValue(child, childKey),
      ]),
    );
  }
  return undefined;
}

export const voiceRenderSettingsAggregateSchema = z.object({
  policy: z.unknown(),
  profile: z.unknown(),
  corrections: z.unknown(),
  ttsPlan: z.unknown(),
  persona: z.unknown().optional(),
  rewrite: z.unknown().optional(),
  legacyGainDb: z.number(),
}).strict().superRefine((settings, ctx) => {
  for (const key of ['policy', 'profile', 'corrections', 'ttsPlan'] as const) {
    if (!Object.hasOwn(settings, key) || settings[key] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `render settings aggregate requires ${key}`,
      });
    }
  }
});
export type VoiceRenderSettingsAggregate =
  z.infer<typeof voiceRenderSettingsAggregateSchema>;

const voiceSettingsSnapshotFileSchema = z.object({
  schemaVersion: z.literal(1),
  settingsHash: z.string().regex(/^[a-f0-9]{64}$/),
  settings: voiceRenderSettingsAggregateSchema,
}).strict().superRefine((snapshot, ctx) => {
  if (canonicalSha256(snapshot.settings) !== snapshot.settingsHash) {
    ctx.addIssue({
      code: 'custom',
      path: ['settingsHash'],
      message: 'settings snapshot hash does not match its content',
    });
  }
  if (
    canonicalSha256(snapshotValue(snapshot.settings))
    !== canonicalSha256(snapshot.settings)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['settings'],
      message: 'settings snapshot contains private host or credential data',
    });
  }
});

function voiceSettingsSnapshotPath(settingsHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(settingsHash)) {
    throw new Error('invalid voice settings snapshot hash');
  }
  return `${config.voiceAudit.settingsSnapshotsDir}/${settingsHash}.json`;
}

export async function persistVoiceSettingsSnapshot(
  settingsHash: string,
  settings: VoiceRenderSettingsAggregate,
): Promise<void> {
  const snapshot = voiceSettingsSnapshotFileSchema.parse({
    schemaVersion: 1,
    settingsHash,
    settings,
  });
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  const path = voiceSettingsSnapshotPath(settingsHash);
  try {
    await writeDurableFileExclusive(path, body);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    let existing: z.infer<typeof voiceSettingsSnapshotFileSchema>;
    try {
      existing = voiceSettingsSnapshotFileSchema.parse(
        JSON.parse((await readDurableRegularFile(path)).toString('utf8')),
      );
    } catch {
      throw new Error(`voice settings snapshot collision: ${settingsHash}`);
    }
    if (canonicalSha256(existing) !== canonicalSha256(snapshot)) {
      throw new Error(`voice settings snapshot collision: ${settingsHash}`);
    }
  }
  await makeDurableFileReadOnly(path);
}

async function readVoiceSettingsSnapshot(
  settingsHash: string,
): Promise<z.infer<typeof voiceSettingsSnapshotFileSchema>> {
  const path = voiceSettingsSnapshotPath(settingsHash);
  try {
    const snapshot = await withDurableRegularFile(path, async (handle, target) => {
      if ((target.mode & 0o222) !== 0) {
        throw new Error('snapshot file is writable');
      }
      return voiceSettingsSnapshotFileSchema.parse(
        JSON.parse((await handle.readFile()).toString('utf8')),
      );
    });
    if (snapshot.settingsHash !== settingsHash) {
      throw new Error('snapshot file hash does not match its name');
    }
    return snapshot;
  } catch (err: unknown) {
    const detail = redactVoiceAuditError(
      err instanceof Error ? err.message : 'unavailable',
    );
    throw new Error(
      `historical voice settings snapshot is unavailable: ${settingsHash}; ${detail}`,
    );
  }
}

function measuredMixerCapabilities(
  value: unknown,
): z.infer<typeof goldenMixerCapabilitiesSchema> | null {
  const result = goldenMixerCapabilitiesSchema.safeParse(value);
  if (
    !result.success
    || !result.data.features.correlatedVoiceEnd.supported
    || !result.data.features.correlatedVoiceEnd.active
  ) {
    return null;
  }
  return result.data;
}

function safeVoiceSettings(value: unknown): Record<string, unknown> {
  const rec = record(value);
  const tts = record(rec.tts);
  const personas = Array.isArray(rec.personas)
    ? rec.personas.map((persona) => {
        const details = record(persona);
        return {
          id: snapshotValue(stringValue(details.id)),
          name: snapshotValue(stringValue(details.name)),
          tts: snapshotValue(details.tts),
        };
      })
    : [];
  const safeTts = snapshotValue({
    ...tts,
    broadcastQa: normalizeBroadcastQa(tts.broadcastQa),
  });
  return {
    schemaVersion: 1,
    timezone: stringValue(rec.timezone) ?? '',
    tts: safeTts,
    personas,
  };
}

function requireMeasuredPairs(
  events: readonly VoiceAuditEvent[],
  expectedHour: string,
  timeZone: string,
  hourStartedAtMs: number,
  hourEndedAtMs: number,
): {
  starts: Array<Extract<VoiceAuditEvent, { type: 'voice.started' }>>;
  endedByVoice: Map<string, Extract<VoiceAuditEvent, { type: 'voice.ended' }>>;
} {
  const allStarts = events.filter(
    (event): event is Extract<VoiceAuditEvent, { type: 'voice.started' }> =>
      event.type === 'voice.started',
  );
  const startsByVoice =
    new Map<string, Array<Extract<VoiceAuditEvent, { type: 'voice.started' }>>>();
  for (const event of allStarts) {
    if (!event.voiceId) throw new Error('voice.started record has no voiceId correlation');
    const group = startsByVoice.get(event.voiceId) ?? [];
    group.push(event);
    startsByVoice.set(event.voiceId, group);
  }
  const allEnded = events.filter(
    (event): event is Extract<VoiceAuditEvent, { type: 'voice.ended' }> =>
      event.type === 'voice.ended',
  );
  const allEndedByVoice =
    new Map<string, Array<Extract<VoiceAuditEvent, { type: 'voice.ended' }>>>();
  for (const event of allEnded) {
    if (!event.voiceId) throw new Error('voice.ended record has no voiceId correlation');
    const group = allEndedByVoice.get(event.voiceId) ?? [];
    group.push(event);
    allEndedByVoice.set(event.voiceId, group);
  }
  const starts: Array<Extract<VoiceAuditEvent, { type: 'voice.started' }>> = [];
  const endedByVoice =
    new Map<string, Extract<VoiceAuditEvent, { type: 'voice.ended' }>>();
  const voiceIds = new Set([
    ...startsByVoice.keys(),
    ...allEndedByVoice.keys(),
  ]);
  const maximumVoiceDurationMs = 75_000;
  for (const voiceId of voiceIds) {
    const startGroup = startsByVoice.get(voiceId) ?? [];
    const endGroup = allEndedByVoice.get(voiceId) ?? [];
    const completePairOverlapsHour =
      startGroup.length === 1
      && endGroup.length === 1
      && startGroup[0].payload.clipStartedAt < hourEndedAtMs
      && endGroup[0].payload.clipEndedAt > hourStartedAtMs;
    const relevant =
      completePairOverlapsHour
      || startGroup.some((event) =>
        event.stationHourKey === expectedHour
        || (
          event.payload.clipStartedAt >= hourStartedAtMs - maximumVoiceDurationMs
          && event.payload.clipStartedAt < hourEndedAtMs
        ))
      || endGroup.some((event) =>
        event.stationHourKey === expectedHour
        || (
          event.payload.clipEndedAt > hourStartedAtMs
          && event.payload.clipEndedAt
            <= hourEndedAtMs + maximumVoiceDurationMs
        ));
    if (!relevant) continue;
    if (startGroup.length === 0) {
      throw new Error(`voice.ended ${voiceId} has no correlated voice.started`);
    }
    if (startGroup.length > 1) {
      throw new Error(`duplicate voice.started record for ${voiceId}`);
    }
    if (endGroup.length === 0) {
      throw new Error(`voice.started ${voiceId} has no correlated voice.ended`);
    }
    if (endGroup.length > 1) {
      throw new Error(`duplicate voice.ended record for ${voiceId}`);
    }
    const start = startGroup[0];
    const end = endGroup[0];
    const overlapsHour =
      start.payload.clipStartedAt < hourEndedAtMs
      && end.payload.clipEndedAt > hourStartedAtMs;
    if (!overlapsHour) {
      if (
        start.stationHourKey === expectedHour
        || end.stationHourKey === expectedHour
      ) {
        throw new Error(`voice lifecycle ${voiceId} falls outside the selected station hour`);
      }
      continue;
    }
    if (!start.payload.measured) {
      throw new Error(`voice.started ${voiceId} is estimated, not mixer-measured`);
    }
    const actualStartHour = stationHourKey(
      new Date(start.payload.clipStartedAt),
      timeZone,
    );
    if (
      actualStartHour !== expectedHour
      || start.stationHourKey !== actualStartHour
      || end.stationHourKey !== start.stationHourKey
      || start.payload.clipStartedAt < hourStartedAtMs
      || end.payload.clipEndedAt > hourEndedAtMs
    ) {
      throw new Error(
        `voice lifecycle ${voiceId} falls outside the selected station hour or misstates its key`,
      );
    }
    if (!end.payload.measured || end.payload.audibleEndedAt === undefined) {
      throw new Error(`voice.ended ${voiceId} is estimated, not mixer-measured`);
    }
    if (
      end.payload.reason !== 'natural'
      || end.payload.clipEndedAt <= start.payload.clipStartedAt
    ) {
      throw new Error(`voice.ended ${voiceId} is not a complete natural playout in the selected hour`);
    }
    if (
      end.auditId !== start.auditId
      || end.payload.artifactId !== start.payload.artifactId
    ) {
      throw new Error(`voice lifecycle correlation changed for ${voiceId}`);
    }
    if (
      end.payload.clipEndedAt < start.payload.clipStartedAt
      || end.payload.audibleEndedAt < start.payload.audibleStartedAt
    ) {
      throw new Error(`voice lifecycle ends before it starts for ${voiceId}`);
    }
    if (events.some((event) =>
      event.type === 'voice.dropped'
      && event.auditId === start.auditId
      && event.voiceId === voiceId)) {
      throw new Error(`voice lifecycle ${voiceId} has conflicting dropped evidence`);
    }
    starts.push(start);
    endedByVoice.set(voiceId, end);
  }
  if (starts.length === 0) {
    throw new Error('golden hour has no correlated voice.started records');
  }
  return { starts, endedByVoice };
}

function requireAcceptedAuditChains(
  events: readonly VoiceAuditEvent[],
  starts: ReadonlyArray<Extract<VoiceAuditEvent, { type: 'voice.started' }>>,
  artifactEvents: ReadonlyMap<
    string,
    Extract<VoiceAuditEvent, { type: 'voice.artifact' }>
  >,
): void {
  for (const start of starts) {
    const voiceId = start.voiceId;
    if (!voiceId) throw new Error('voice.started record has no voiceId correlation');
    const chain = events.filter((event) => event.auditId === start.auditId);
    const textPolicyEvents = chain.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.text_policy' }> =>
        event.type === 'voice.text_policy',
    );
    const textPolicies = textPolicyEvents.filter(
      (event) => event.payload.outcome === 'passed',
    );
    const renderAttempts = chain.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.render_attempt' }> =>
        event.type === 'voice.render_attempt',
    );
    const acceptedAttempts = renderAttempts.filter(
      (event) => event.payload.status === 'accepted',
    );
    const rewrites = chain.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.rewrite' }> =>
        event.type === 'voice.rewrite',
    );
    const qaPassedEvents = chain.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.qa_passed' }> =>
        event.type === 'voice.qa_passed',
    );
    const qaPassed = qaPassedEvents.filter(
      (event) =>
        event.type === 'voice.qa_passed'
        && event.payload.artifactId === start.payload.artifactId,
    );
    const chainArtifacts = chain.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.artifact' }> =>
        event.type === 'voice.artifact',
    );
    const terminalFailures = chain.filter((event) =>
      event.type === 'voice.qa_failed' || event.type === 'voice.dropped');
    if (terminalFailures.length > 0) {
      throw new Error(`voice ${voiceId} has contradictory terminal failure evidence`);
    }
    const queued = chain.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.queued' }> =>
        event.type === 'voice.queued'
        && event.voiceId === voiceId
        && event.payload.artifactId === start.payload.artifactId,
    );
    const ended = chain.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.ended' }> =>
        event.type === 'voice.ended'
        && event.voiceId === voiceId
        && event.payload.artifactId === start.payload.artifactId,
    );
    if (
      textPolicyEvents.length !== 1
      || textPolicies.length !== 1
      || acceptedAttempts.length !== 1
      || qaPassedEvents.length !== 1
      || qaPassed.length !== 1
      || chainArtifacts.length !== 1
      || queued.length !== 1
      || ended.length !== 1
    ) {
      throw new Error(`voice ${voiceId} has no unique accepted QA audit chain`);
    }
    const artifactEvent = artifactEvents.get(start.payload.artifactId);
    if (
      !artifactEvent
      || artifactEvent.auditId !== start.auditId
      || chainArtifacts[0].eventId !== artifactEvent.eventId
    ) {
      throw new Error(`voice ${voiceId} has no correlated accepted artifact`);
    }
    const artifact = artifactEvent.payload.artifact;
    const textPolicyEvent = textPolicies[0];
    const textPolicy = textPolicies[0].payload;
    const attemptEvent = acceptedAttempts[0];
    const attempt = attemptEvent.payload;
    const passedEvent = qaPassed[0];
    const passed = passedEvent.payload;
    const queuedEvent = queued[0];
    const endedEvent = ended[0];
    if (attempt.status !== 'accepted' || !attempt.evidence.final) {
      throw new Error(`voice ${voiceId} has no accepted final render evidence`);
    }
    const orderedAttempts = [...renderAttempts].sort((left, right) =>
      left.payload.startedAtMs - right.payload.startedAtMs
      || left.payload.endedAtMs - right.payload.endedAtMs
      || left.atMs - right.atMs
      || left.eventId.localeCompare(right.eventId));
    if (
      orderedAttempts.at(-1) !== attemptEvent
      || orderedAttempts.some((event, index) =>
        event.atMs < event.payload.endedAtMs
        || (
          index > 0
          && (
            event.payload.startedAtMs < orderedAttempts[index - 1].payload.endedAtMs
            || orderedAttempts[index - 1].atMs > event.payload.startedAtMs
          )
        ))
    ) {
      throw new Error(`voice ${voiceId} render attempt chronology is inconsistent`);
    }
    const firstAttempt = orderedAttempts[0];
    const finalEvidence = attempt.evidence.final;
    let replacementReplay = textPolicy.inputDisplayText;
    for (let index = 0; index < textPolicy.replacements.length;) {
      const step = textPolicy.replacements[index].step;
      const group: typeof textPolicy.replacements = [];
      while (
        index < textPolicy.replacements.length
        && textPolicy.replacements[index].step === step
      ) {
        group.push(textPolicy.replacements[index]);
        index += 1;
      }
      for (const replacement of group.reverse()) {
        replacementReplay =
          replacementReplay.slice(0, replacement.sourceStart)
          + replacement.replacement
          + replacementReplay.slice(replacement.sourceEnd);
      }
    }
    if (
      artifact.rewriteCount === 0
      ? rewrites.length !== 0 || replacementReplay !== artifact.displayText
      : (
        rewrites.length !== 1
        || rewrites[0].payload.outcome !== 'passed'
        || rewrites[0].payload.beforeHash === rewrites[0].payload.afterHash
        || rewrites[0].payload.beforeHash !== canonicalSha256(replacementReplay)
        || rewrites[0].payload.afterHash !== canonicalSha256(artifact.displayText)
      )
    ) {
      throw new Error(`voice ${voiceId} rewrite history does not match its artifact`);
    }
    if (
      queuedEvent.stationHourKey !== start.stationHourKey
      || queuedEvent.payload.queue !== start.payload.queue
      || queuedEvent.payload.queuedAtMs > start.payload.clipStartedAt
      || artifactEvent.atMs > queuedEvent.payload.queuedAtMs
      || Math.abs(
        start.payload.audibleStartedAt
          - start.payload.clipStartedAt
          - artifact.firstVoiceMs,
      ) > GOLDEN_MARKER_TOLERANCE_MS
      || Math.abs(
        endedEvent.payload.clipEndedAt
          - start.payload.clipStartedAt
          - artifact.durationMs,
      ) > GOLDEN_MARKER_TOLERANCE_MS
      || endedEvent.payload.audibleEndedAt === undefined
      || Math.abs(
        endedEvent.payload.audibleEndedAt
          - start.payload.clipStartedAt
          - artifact.lastVoiceMs,
      ) > GOLDEN_MARKER_TOLERANCE_MS
    ) {
      throw new Error(`voice ${voiceId} playout geometry does not match its artifact`);
    }
    const artifactCreatedAtMs = Date.parse(artifact.createdAt);
    if (
      !Number.isSafeInteger(artifactCreatedAtMs)
      || artifact.renderSnapshot.capturedAtMs > textPolicyEvent.atMs
      || artifact.renderSnapshot.capturedAtMs > firstAttempt.payload.startedAtMs
      || textPolicyEvent.atMs > firstAttempt.payload.startedAtMs
      || rewrites.some((event) =>
        event.atMs < artifact.renderSnapshot.capturedAtMs
        || event.atMs < textPolicyEvent.atMs
        || event.atMs > firstAttempt.payload.startedAtMs)
      || attempt.endedAtMs > attemptEvent.atMs
      || attemptEvent.atMs > passedEvent.atMs
      || passedEvent.atMs > artifactEvent.atMs
      || artifactCreatedAtMs < Math.max(attempt.endedAtMs, passedEvent.atMs)
      || artifactCreatedAtMs > artifactEvent.atMs
      || artifactEvent.atMs > queuedEvent.payload.queuedAtMs
      || queuedEvent.atMs < queuedEvent.payload.queuedAtMs
      || queuedEvent.payload.queuedAtMs > start.payload.clipStartedAt
      || start.atMs < start.payload.clipStartedAt
      || start.atMs > endedEvent.payload.clipEndedAt
      || endedEvent.atMs < endedEvent.payload.clipEndedAt
      || endedEvent.atMs < start.atMs
    ) {
      throw new Error(`voice ${voiceId} audit chronology is inconsistent`);
    }
    if (
      textPolicy.displayText !== artifact.displayText
      || textPolicy.spokenTextHash !== canonicalSha256(artifact.spokenText)
      || textPolicy.factLocksHash !== artifact.factLocksHash
      || (
        textPolicy.provenance
          ? canonicalSha256(textPolicy.provenance)
          : undefined
      ) !== artifact.provenanceHash
      || canonicalSha256(textPolicy.renderSnapshot)
        !== canonicalSha256(artifact.renderSnapshot)
      || attempt.textHash !== canonicalSha256(artifact.spokenText)
      || attempt.engine !== artifact.engine
      || attempt.provider !== artifact.provider
      || attempt.voice !== artifact.voice
      || passed.profile !== artifact.profile
      || passed.measurements.durationMs !== artifact.durationMs
      || passed.measurements.firstVoiceMs !== artifact.firstVoiceMs
      || passed.measurements.lastVoiceMs !== artifact.lastVoiceMs
      || passed.measurements.loudnessLufs !== artifact.loudnessLufs
      || passed.measurements.truePeakDbtp !== artifact.truePeakDbtp
      || passed.measurements.leadingSilenceMs !== artifact.leadingSilenceMs
      || passed.measurements.trailingSilenceMs !== artifact.trailingSilenceMs
      || canonicalSha256(passed.measurements.internalPausesMs)
        !== canonicalSha256(artifact.internalPausesMs)
      || finalEvidence.durationMs !== artifact.durationMs
      || finalEvidence.loudnessLufs !== artifact.loudnessLufs
      || finalEvidence.truePeakDbtp !== artifact.truePeakDbtp
      || finalEvidence.leadingSilenceMs !== artifact.leadingSilenceMs
      || finalEvidence.trailingSilenceMs !== artifact.trailingSilenceMs
    ) {
      throw new Error(`voice ${voiceId} accepted QA evidence does not match its artifact`);
    }
    if (
      [
        ...textPolicyEvents,
        ...rewrites,
        ...renderAttempts,
        ...qaPassedEvents,
        artifactEvent,
      ].some((event) => event.atMs > queuedEvent.payload.queuedAtMs)
      || [...queued, artifactEvent].some(
        (event) => event.atMs > start.payload.clipStartedAt,
      )
    ) {
      throw new Error(`voice ${voiceId} acceptance was recorded after queue or playout began`);
    }
  }
}

async function resolveArtifactFile(relativePath: string): Promise<string> {
  const lexical = resolveStatePath(config.stateDir, relativePath);
  if (!lexical) throw new Error(`unsafe voice artifact path: ${relativePath}`);
  const real = await realStatePath(config.stateDir, lexical);
  if (!real) throw new Error(`voice artifact escapes the state directory: ${relativePath}`);
  return real;
}

export interface PinGoldenHourInput {
  hour: string;
  archivePath: string;
  measurements: GoldenMeasurements;
}

export interface GoldenHourManifest {
  schemaVersion: 1;
  stationHourKey: string;
  createdAt: string;
  archive: { file: string; sha256: string };
  audit: { file: 'audit.jsonl'; eventCount: number; sha256: string };
  artifacts: Array<{ artifactId: string; file: string; sha256: string }>;
  settings: { file: 'settings-snapshot.json'; sha256: string };
  capabilities: { file: 'capabilities.json'; sha256: string };
  measurements: { file: 'measurements.json'; sha256: string };
}

const goldenFileEvidenceSchema = z.object({
  file: z.string().min(1).max(512),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const goldenHourManifestSchema = z.object({
  schemaVersion: z.literal(1),
  stationHourKey: stationHourKeySchema,
  createdAt: z.string().min(1).max(128),
  archive: goldenFileEvidenceSchema,
  audit: goldenFileEvidenceSchema.extend({
    file: z.literal('audit.jsonl'),
    eventCount: z.number().int().nonnegative(),
  }),
  artifacts: z.array(goldenFileEvidenceSchema.extend({
    artifactId: z.string().min(1).max(256),
  })).max(10_000),
  settings: goldenFileEvidenceSchema.extend({
    file: z.literal('settings-snapshot.json'),
  }),
  capabilities: goldenFileEvidenceSchema.extend({
    file: z.literal('capabilities.json'),
  }),
  measurements: goldenFileEvidenceSchema.extend({
    file: z.literal('measurements.json'),
  }),
}).strict();

function publishedBundlePath(directory: string, relativePath: string): string {
  const root = resolve(directory);
  const path = resolve(root, relativePath);
  if (
    path === root
    || !path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  ) {
    throw new Error(`golden manifest path escapes its bundle: ${relativePath}`);
  }
  return path;
}

async function validatePublishedGoldenBundle(
  directory: string,
  sealPath: string,
  expectedHour: string,
  directoryStat: Stats,
  sealStat: Stats,
): Promise<GoldenHourManifest> {
  if (
    !directoryStat.isDirectory()
    || (directoryStat.mode & 0o222) !== 0
    || !sealStat.isFile()
    || (sealStat.mode & 0o222) !== 0
  ) {
    throw new Error('golden bundle or seal is writable or not a regular file');
  }
  const manifestPath = `${directory}/manifest.json`;
  const manifestBody = await readDurableRegularFile(manifestPath);
  const expectedSeal =
    `${createHash('sha256').update(manifestBody).digest('hex')}  `
    + `${expectedHour}/manifest.json\n`;
  if ((await readDurableRegularFile(sealPath)).toString('utf8') !== expectedSeal) {
    throw new Error('golden manifest seal does not match');
  }
  const parsed = goldenHourManifestSchema.parse(
    JSON.parse(manifestBody.toString('utf8')),
  );
  if (parsed.stationHourKey !== expectedHour) {
    throw new Error('golden manifest station hour does not match its directory');
  }
  const evidence = [
    parsed.archive,
    parsed.audit,
    ...parsed.artifacts,
    parsed.settings,
    parsed.capabilities,
    parsed.measurements,
  ];
  const files = new Set<string>();
  for (const item of evidence) {
    if (files.has(item.file)) {
      throw new Error(`duplicate golden manifest member: ${item.file}`);
    }
    files.add(item.file);
    const path = publishedBundlePath(directory, item.file);
    const actual = await sha256File(path, { requireReadOnly: true });
    if (actual !== item.sha256) {
      throw new Error(`golden manifest member hash changed: ${item.file}`);
    }
  }
  await sha256File(manifestPath, { requireReadOnly: true });
  const artifactDirectory = `${directory}/artifacts`;
  const artifactDirectoryStat = await lstat(artifactDirectory);
  if (
    !artifactDirectoryStat.isDirectory()
    || (artifactDirectoryStat.mode & 0o222) !== 0
  ) {
    throw new Error('golden artifact directory is writable or invalid');
  }
  const expectedRootNames = new Set([
    'artifacts',
    'manifest.json',
    ...[...files]
      .filter((file) => !file.includes('/')),
  ]);
  const rootNames = await readdir(directory);
  if (
    rootNames.length !== expectedRootNames.size
    || rootNames.some((name) => !expectedRootNames.has(name))
  ) {
    throw new Error('golden bundle contains unmanifested root members');
  }
  const expectedArtifactNames = new Set(
    parsed.artifacts.map((item) => basename(item.file)),
  );
  const artifactNames = await readdir(artifactDirectory);
  if (
    artifactNames.length !== expectedArtifactNames.size
    || artifactNames.some((name) => !expectedArtifactNames.has(name))
  ) {
    throw new Error('golden bundle contains unmanifested artifacts');
  }
  const auditBody = await readDurableRegularFile(
    publishedBundlePath(directory, parsed.audit.file),
  );
  const eventCount = auditBody.toString('utf8').split('\n').filter(Boolean).length;
  if (eventCount !== parsed.audit.eventCount) {
    throw new Error('golden audit event count changed');
  }
  return parsed as GoldenHourManifest;
}

async function removeStaleGoldenStaging(nowMs = Date.now()): Promise<number> {
  let names: string[];
  try {
    await assertDurableDirectory(config.voiceAudit.goldenDir);
    names = await readdir(config.voiceAudit.goldenDir);
    await assertDurableDirectory(config.voiceAudit.goldenDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let removed = 0;
  for (const name of names) {
    const currentMatch = name.match(GOLDEN_STAGING_RE);
    const legacy = !currentMatch && LEGACY_GOLDEN_STAGING_RE.test(name);
    if (!currentMatch && !legacy) continue;
    const path = `${config.voiceAudit.goldenDir}/${name}`;
    const target = await lstat(path);
    if (
      !target.isDirectory()
      || nowMs - target.mtimeMs < STALE_GOLDEN_STAGING_MS
    ) {
      continue;
    }
    // A crash may have happened after the tree was sealed read-only but
    // before rename. Restore write access only on our exact staging shape.
    await assertDurableDirectory(path);
    await makeDurableDirectoryWritable(path);
    const artifactDirectory = `${path}/artifacts`;
    try {
      const artifactTarget = await lstat(artifactDirectory);
      if (artifactTarget.isDirectory()) {
        await makeDurableDirectoryWritable(artifactDirectory);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  if (removed > 0) await syncDurableDirectory(config.voiceAudit.goldenDir);
  return removed;
}

export async function pinGoldenHour(
  input: PinGoldenHourInput,
): Promise<{ directory: string; manifest: GoldenHourManifest }> {
  const pinStartedAtMs = Date.now();
  if (!stationHourKeySchema.safeParse(input.hour).success) {
    throw new Error('invalid station-hour key');
  }
  await removeStaleGoldenStaging();
  const measurements = goldenMeasurementsSchema.parse(input.measurements);
  const measuredAtMs = Date.parse(measurements.measuredAt);
  if (
    measuredAtMs < measurements.archiveEndedAtMs
    || measuredAtMs > pinStartedAtMs
  ) {
    throw new Error(
      'independent measurements must follow archive completion and precede pinning',
    );
  }
  if (canonicalSha256(snapshotValue(measurements)) !== canonicalSha256(measurements)) {
    throw new Error('golden-hour measurements contain private host or credential data');
  }
  const archiveSha256 = await sha256File(input.archivePath);
  if (archiveSha256 !== measurements.archiveSha256) {
    throw new Error('independent measurements do not match the archive SHA-256');
  }
  if (measurements.integratedLufs < -18 || measurements.integratedLufs > -16) {
    throw new Error('golden-hour final bus is outside minus seventeen ± one LUFS');
  }
  if (measurements.truePeakDbtp > -1) {
    throw new Error('golden-hour final bus exceeds minus one dBTP');
  }

  const capabilitiesPath = `${config.stateDir}/capabilities.json`;
  let capabilities: unknown;
  try {
    capabilities = JSON.parse(
      (await readDurableRegularFile(capabilitiesPath)).toString('utf8'),
    );
  } catch {
    throw new Error(
      'mixer correlated voice-end capability is unavailable; the golden-hour command cannot bless estimated evidence',
    );
  }
  const mixerCapabilities = measuredMixerCapabilities(capabilities);
  if (!mixerCapabilities) {
    throw new Error(
      'mixer correlated voice-end capability is not active; the golden-hour command cannot bless estimated evidence',
    );
  }

  let rawSettings: unknown;
  try {
    rawSettings = JSON.parse(
      (await readDurableRegularFile(`${config.stateDir}/settings.json`)).toString('utf8'),
    );
  } catch {
    throw new Error('settings snapshot is unavailable');
  }
  const settingsSnapshot = safeVoiceSettings(rawSettings);
  const snapshotTts = record(settingsSnapshot.tts);
  const snapshotQa = record(snapshotTts.broadcastQa);
  if (snapshotQa.enabled !== true) {
    throw new Error('the settings snapshot does not have broadcast QA enabled');
  }
  const configuredZone = stringValue(record(rawSettings).timezone);
  const timeZone = configuredZone || getStationTimezone();
  if (
    measurements.stationHourKey !== input.hour
    || measurements.archiveDurationMs !== 60 * 60 * 1_000
    || stationHourKey(new Date(measurements.archiveStartedAtMs), timeZone) !== input.hour
    || stationHourKey(new Date(measurements.archiveEndedAtMs - 1), timeZone) !== input.hour
  ) {
    throw new Error('independent measurements do not cover the selected station hour');
  }
  const hourZone = input.hour.slice(input.hour.indexOf('@') + 1);
  if (hourZone !== timeZone.replaceAll('/', '_')) {
    throw new Error('selected station hour does not match the settings timezone');
  }
  if (stationHourKey(new Date(), timeZone) === input.hour) {
    throw new Error('the active station hour cannot be pinned before its archive closes');
  }

  const allEvents = orderAndDedupeAuditEvents(
    await readLedgerAndSpoolEvents(),
  );
  const hourEvents = allEvents.filter((event) => event.stationHourKey === input.hour);
  const { starts } = requireMeasuredPairs(
    allEvents,
    input.hour,
    timeZone,
    measurements.archiveStartedAtMs,
    measurements.archiveEndedAtMs,
  );
  if (
    mixerCapabilities.mixerBootTime * 1_000
    > Math.min(...starts.map((event) => event.payload.clipStartedAt))
  ) {
    throw new Error('selected voice evidence predates the current mixer capability snapshot');
  }
  const artifactEvents = new Map<string, Extract<VoiceAuditEvent, { type: 'voice.artifact' }>>();
  for (const event of allEvents) {
    if (event.type === 'voice.artifact') {
      if (artifactEvents.has(event.payload.artifact.artifactId)) {
        throw new Error(`duplicate voice.artifact record for ${event.payload.artifact.artifactId}`);
      }
      artifactEvents.set(event.payload.artifact.artifactId, event);
    }
  }

  const artifacts: Array<{
    artifactId: string;
    source: string;
    file: string;
    sha256: string;
    event: Extract<VoiceAuditEvent, { type: 'voice.artifact' }>;
  }> = [];
  const artifactFiles = new Set<string>();
  for (const artifactId of [...new Set(starts.map((event) => event.payload.artifactId))]) {
    const event = artifactEvents.get(artifactId);
    if (!event) throw new Error(`missing voice.artifact record for ${artifactId}`);
    const references = starts.filter((start) => start.payload.artifactId === artifactId);
    for (const start of references) {
      if (
        event.auditId !== start.auditId
        || (event.voiceId !== undefined && event.voiceId !== start.voiceId)
        || event.atMs > start.payload.clipStartedAt
      ) {
        throw new Error(`voice artifact correlation changed for ${artifactId}`);
      }
    }
    const source = await resolveArtifactFile(event.payload.artifact.path);
    const sha256 = await sha256File(source, { requireReadOnly: true });
    if (sha256 !== event.payload.artifact.sha256) {
      throw new Error(`voice artifact hash changed for ${artifactId}`);
    }
    const file = `artifacts/${basename(event.payload.artifact.path)}`;
    if (artifactFiles.has(file)) {
      throw new Error(`voice artifacts collide in the golden bundle: ${file}`);
    }
    artifactFiles.add(file);
    artifacts.push({
      artifactId,
      source,
      file,
      sha256,
      event,
    });
  }
  requireAcceptedAuditChains(allEvents, starts, artifactEvents);
  const historicalSettings = await Promise.all(
    [...new Set(artifacts.map(
      ({ event }) => event.payload.artifact.renderSnapshot.settingsHash,
    ))].map(readVoiceSettingsSnapshot),
  );
  const historicalByHash = new Map(
    historicalSettings.map((snapshot) => [snapshot.settingsHash, snapshot]),
  );
  for (const { event } of artifacts) {
    const render = event.payload.artifact.renderSnapshot;
    const historical = historicalByHash.get(render.settingsHash);
    if (!historical) {
      throw new Error('historical voice settings snapshot is unavailable');
    }
    const components = [
      ['policy', render.policyHash],
      ['profile', render.profileHash],
      ['corrections', render.correctionsHash],
      ['ttsPlan', render.ttsPlanHash],
    ] as const;
    for (const [component, expectedHash] of components) {
      if (canonicalSha256(historical.settings[component]) !== expectedHash) {
        throw new Error(
          `historical voice settings ${component} hash does not match render evidence`,
        );
      }
    }
    const personaHash = historical.settings.persona === undefined
      ? undefined
      : canonicalSha256(historical.settings.persona);
    if (
      personaHash !== render.personaHash
      || historical.settings.legacyGainDb !== render.legacyGainDb
    ) {
      throw new Error('historical voice persona or gain does not match render evidence');
    }
  }

  const auditIds = new Set(starts.map((event) => event.auditId));
  const relevantEvents = orderAndDedupeAuditEvents([
    ...allEvents.filter((event) => auditIds.has(event.auditId)),
    ...hourEvents,
  ]);
  const auditBody = relevantEvents.map((event) => JSON.stringify(event)).join('\n') + '\n';
  const settingsBody = `${JSON.stringify({
    schemaVersion: 1,
    evidenceKind: 'historical-render-config-plus-pin-time-config',
    capturedAt: new Date().toISOString(),
    pinTimeSettings: settingsSnapshot,
    historicalSettings,
    artifactRenderSnapshots: artifacts.map(({ artifactId, event }) => ({
      artifactId,
      auditId: event.auditId,
      renderSnapshot: event.payload.artifact.renderSnapshot,
    })),
  }, null, 2)}\n`;
  const capabilitiesBody = `${JSON.stringify(mixerCapabilities, null, 2)}\n`;
  const measurementsBody = `${JSON.stringify(measurements, null, 2)}\n`;
  const archiveFile = `final-bus${extname(input.archivePath) || '.bin'}`;
  const destination = `${config.voiceAudit.goldenDir}/${input.hour}`;
  const sealPath = `${config.voiceAudit.goldenDir}/${input.hour}.sha256`;
  await ensureDurableDirectory(config.voiceAudit.goldenDir);
  let destinationStat: Stats | undefined;
  try {
    destinationStat = await lstat(destination);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (destinationStat) {
    try {
      const sealStat = await lstat(sealPath);
      await validatePublishedGoldenBundle(
        destination,
        sealPath,
        input.hour,
        destinationStat,
        sealStat,
      );
    } catch (err: unknown) {
      const detail = redactVoiceAuditError(
        err instanceof Error ? err.message : 'validation failed',
      );
      throw new Error(
        `golden hour has an incomplete or writable pin requiring operator review: `
          + `${input.hour}; ${detail}`,
      );
    }
    throw new Error(`golden hour is already pinned: ${input.hour}`);
  }
  try {
    await lstat(sealPath);
    throw new Error(
      `golden hour has an incomplete pin requiring operator review: ${input.hour}`,
    );
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // Publish one fully-fsynced staging directory by rename. A crash before the
  // rename leaves no directory that can be mistaken for a completed pin.
  const staging =
    `${config.voiceAudit.goldenDir}/.${input.hour}.${process.pid}.`
    + `${randomBytes(6).toString('hex')}.tmp`;
  try {
    await mkdir(`${staging}/artifacts`, { recursive: true });
    const stagedArchive = `${staging}/${archiveFile}`;
    await copyDurableFileAtomic(input.archivePath, stagedArchive);
    if (await sha256File(stagedArchive) !== archiveSha256) {
      throw new Error('golden-hour archive changed while it was being copied');
    }
    await writeDurableFileAtomic(`${staging}/audit.jsonl`, auditBody);
    await writeDurableFileAtomic(`${staging}/settings-snapshot.json`, settingsBody);
    await writeDurableFileAtomic(`${staging}/capabilities.json`, capabilitiesBody);
    await writeDurableFileAtomic(`${staging}/measurements.json`, measurementsBody);
    for (const artifact of artifacts) {
      const stagedArtifact = `${staging}/${artifact.file}`;
      await copyDurableFileAtomic(artifact.source, stagedArtifact);
      if (await sha256File(stagedArtifact) !== artifact.sha256) {
        throw new Error(`voice artifact changed while it was being copied: ${artifact.artifactId}`);
      }
    }
    const manifest: GoldenHourManifest = {
      schemaVersion: 1,
      stationHourKey: input.hour,
      createdAt: new Date().toISOString(),
      archive: { file: archiveFile, sha256: archiveSha256 },
      audit: {
        file: 'audit.jsonl',
        eventCount: relevantEvents.length,
        sha256: createHash('sha256').update(auditBody).digest('hex'),
      },
      artifacts: artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        file: artifact.file,
        sha256: artifact.sha256,
      })),
      settings: {
        file: 'settings-snapshot.json',
        sha256: createHash('sha256').update(settingsBody).digest('hex'),
      },
      capabilities: {
        file: 'capabilities.json',
        sha256: createHash('sha256').update(capabilitiesBody).digest('hex'),
      },
      measurements: {
        file: 'measurements.json',
        sha256: createHash('sha256').update(measurementsBody).digest('hex'),
      },
    };
    const manifestPath = `${staging}/manifest.json`;
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeDurableFileAtomic(manifestPath, manifestBody);
    for (const path of [
      stagedArchive,
      `${staging}/audit.jsonl`,
      `${staging}/settings-snapshot.json`,
      `${staging}/capabilities.json`,
      `${staging}/measurements.json`,
      ...artifacts.map((artifact) => `${staging}/${artifact.file}`),
      manifestPath,
    ]) {
      await makeDurableFileReadOnly(path);
    }
    await makeDurableDirectoryReadOnly(`${staging}/artifacts`);
    await syncDurableDirectory(staging);
    await makeDurableDirectoryReadOnly(staging);
    try {
      await rename(staging, destination);
    } catch (err: unknown) {
      if (
        (err as NodeJS.ErrnoException).code !== 'EACCES'
        && (err as NodeJS.ErrnoException).code !== 'EPERM'
      ) {
        throw err;
      }
      // Darwin refuses to rename a directory without its owner-write bit.
      // Restore it only for the rename, reseal immediately, and publish the
      // external digest last. A crash in this fallback leaves no seal, so the
      // writable directory can never validate as a completed golden pin.
      await makeDurableDirectoryWritable(staging);
      await rename(staging, destination);
      await makeDurableDirectoryReadOnly(destination);
    }
    await syncDurableDirectory(config.voiceAudit.goldenDir);
    await writeDurableFileExclusive(
      sealPath,
      `${createHash('sha256').update(manifestBody).digest('hex')}  `
        + `${input.hour}/manifest.json\n`,
    );
    await makeDurableFileReadOnly(sealPath);
    return { directory: destination, manifest };
  } catch (err) {
    await makeDurableDirectoryWritable(`${staging}/artifacts`).catch(() => undefined);
    await makeDurableDirectoryWritable(staging).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
