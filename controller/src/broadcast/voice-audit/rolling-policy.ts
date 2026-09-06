// Durable station-hour occurrence reservations. The pure recheck is shared by
// render-time policy and the serialized pre-handoff reservation operation.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BroadcastQaRule } from '../../schemas/voice.js';
import { getStationTimezone, stationHourKey } from '../../time.js';
import {
  readDurableRegularFile,
  writeDurableFileAtomic,
} from '../../util/durable-file.js';
import { findLiteralMatches } from '../../audio/voice-qa/fact-locks.js';
import { config } from '../../config.js';
import {
  appendLedgerEvent,
  appendPreAir,
  type PreAirAuditResult,
} from './ledger.js';
import { appendPostAir, readLedgerAndSpoolEvents } from './spool.js';
import {
  automaticVoiceAuditAllowed,
  latchVoiceAuditUnhealthy,
  logVoiceAuditError,
  redactVoiceAuditError,
} from './health.js';
import {
  orderAndDedupeAuditEvents,
} from './ledger.js';
import {
  auditStringPrivacyIssue,
  stationHourKeySchema,
  type VoiceAuditEvent,
} from './types.js';

export type StationHourRule = Extract<BroadcastQaRule, { type: 'station-hour-limit' }>;

export interface RollingHistoryOccurrence {
  reservationId?: string;
  auditId: string;
  ruleId: string;
  value: string;
  stationHourKey: string;
}

export interface RollingReservation extends RollingHistoryOccurrence {
  reservationId: string;
  traceId?: string;
  candidateId?: string;
  voiceId: string;
  max: number;
  expiresAtMs: number;
  createdAtMs: number;
}

const rollingReservationSchema = z.object({
  reservationId: z.string().min(1).max(256),
  auditId: z.string().min(1).max(256),
  traceId: z.string().min(1).max(256).optional(),
  candidateId: z.string().min(1).max(256).optional(),
  voiceId: z.string().min(1).max(256),
  ruleId: z.string().min(1).max(128),
  value: z.string().min(1).max(50_000),
  max: z.number().int().nonnegative(),
  stationHourKey: stationHourKeySchema,
  expiresAtMs: z.number().int().nonnegative(),
  createdAtMs: z.number().int().nonnegative(),
}).strict();

const rollingReservationFileSchema = z.object({
  schemaVersion: z.literal(1),
  reservations: z.array(rollingReservationSchema).max(10_000),
}).strict().superRefine((file, ctx) => {
  const ids = new Set<string>();
  for (let index = 0; index < file.reservations.length; index++) {
    const reservation = file.reservations[index];
    const id = reservation.reservationId;
    if (ids.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['reservations', index, 'reservationId'],
        message: `duplicate rolling reservation ID: ${id}`,
      });
    }
    ids.add(id);
    for (const [key, value] of Object.entries(reservation)) {
      if (typeof value !== 'string') continue;
      const issue = auditStringPrivacyIssue(value);
      if (issue) {
        ctx.addIssue({
          code: 'custom',
          path: ['reservations', index, key],
          message: `unsafe rolling reservation: ${issue}`,
        });
      }
    }
  }
});

export interface RollingRuleRequest {
  displayText: string;
  rules: readonly StationHourRule[];
  stationHourKey: string;
}

export type RollingRuleDecision =
  | {
      ok: true;
      occurrences: Array<{ ruleId: string; value: string; stationHourKey: string }>;
      failedRuleIds: [];
    }
  | {
      ok: false;
      occurrences: [];
      failedRuleIds: string[];
    };

export function recheckRollingRules(
  history: readonly RollingHistoryOccurrence[],
  reservations: readonly RollingReservation[],
  request: RollingRuleRequest,
  _nowMs: number,
): RollingRuleDecision {
  if (!stationHourKeySchema.safeParse(request.stationHourKey).success) {
    throw new Error('invalid station-hour key');
  }
  const startedReservationIds = new Set(
    history.flatMap((row) => row.reservationId ? [row.reservationId] : []),
  );
  const occurrences: Array<{ ruleId: string; value: string; stationHourKey: string }> = [];
  const failedRuleIds: string[] = [];
  for (const rule of request.rules) {
    const hits = findLiteralMatches(request.displayText, rule.value, {
      caseSensitive: false,
      boundary: 'both',
    }).length;
    if (hits === 0) continue;
    const priorHistory = history.filter((row) =>
      row.ruleId === rule.id
      && row.value === rule.value
      && row.stationHourKey === request.stationHourKey).length;
    // Expiry only makes a reservation eligible for reference-aware recovery.
    // Until that recovery proves it unreferenced and removes it durably, it
    // must continue consuming allowance.
    const priorReservations = reservations.filter((row) =>
      !startedReservationIds.has(row.reservationId)
      && row.ruleId === rule.id
      && row.value === rule.value
      && row.stationHourKey === request.stationHourKey).length;
    if (priorHistory + priorReservations + hits > rule.max) {
      failedRuleIds.push(rule.id);
      continue;
    }
    for (let i = 0; i < hits; i++) {
      occurrences.push({
        ruleId: rule.id,
        value: rule.value,
        stationHourKey: request.stationHourKey,
      });
    }
  }
  if (failedRuleIds.length) {
    return { ok: false, occurrences: [], failedRuleIds: [...new Set(failedRuleIds)] };
  }
  return { ok: true, occurrences, failedRuleIds: [] };
}

export async function readRollingReservations(): Promise<RollingReservation[]> {
  let raw: string;
  try {
    raw = (await readDurableRegularFile(
      config.voiceAudit.rollingReservationsFile,
    )).toString('utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('rolling-reservations.json is not valid JSON');
  }
  const result = rollingReservationFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`invalid rolling-reservations.json: ${result.error.issues[0]?.message ?? 'schema mismatch'}`);
  }
  return result.data.reservations;
}

async function writeRollingReservations(reservations: readonly RollingReservation[]): Promise<void> {
  const body = rollingReservationFileSchema.parse({
    schemaVersion: 1,
    reservations,
  });
  await writeDurableFileAtomic(
    config.voiceAudit.rollingReservationsFile,
    `${JSON.stringify(body, null, 2)}\n`,
  );
}

function startedHistory(events: readonly VoiceAuditEvent[]): RollingHistoryOccurrence[] {
  const reservations = new Map<string, Extract<VoiceAuditEvent, { type: 'voice.policy_reserved' }>>();
  const starts: Array<Extract<VoiceAuditEvent, { type: 'voice.started' }>> = [];
  for (const event of events) {
    if (event.type === 'voice.policy_reserved') {
      if (reservations.has(event.payload.reservationId)) {
        throw new Error(
          `duplicate rolling reservation evidence: ${event.payload.reservationId}`,
        );
      }
      reservations.set(event.payload.reservationId, event);
    } else if (event.type === 'voice.started') {
      starts.push(event);
    }
  }
  const out: RollingHistoryOccurrence[] = [];
  for (const [reservationId, event] of reservations) {
    const started = starts.some((candidate) => (
      candidate.auditId === event.auditId
      && candidate.stationHourKey === event.payload.stationHourKey
      && candidate.voiceId === event.voiceId
      && candidate.candidateId === event.candidateId
      && candidate.traceId === event.traceId
      && candidate.atMs >= event.atMs
      && candidate.payload.clipStartedAt >= event.atMs
    ));
    if (!started) continue;
    out.push({
      reservationId,
      auditId: event.auditId,
      ruleId: event.payload.ruleId,
      value: event.payload.value,
      stationHourKey: event.payload.stationHourKey,
    });
  }
  return out;
}

export async function readStartedRollingHistory(): Promise<RollingHistoryOccurrence[]> {
  const events = orderAndDedupeAuditEvents(await readLedgerAndSpoolEvents());
  return startedHistory(events);
}

let rollingTail: Promise<void> = Promise.resolve();

function withRollingMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = rollingTail.catch(() => undefined).then(fn);
  rollingTail = run.then(() => undefined, () => undefined);
  return run;
}

export function withActiveRollingReservations<T>(
  fn: (reservations: RollingReservation[]) => Promise<T>,
): Promise<T> {
  return withRollingMutex(async () => fn(await readRollingReservations()));
}

interface RollingReservationOwner {
  auditId: string;
  traceId?: string;
  candidateId?: string;
  voiceId: string;
}

export interface ReserveRollingRulesRequest extends RollingReservationOwner {
  displayText: string;
  rules: readonly StationHourRule[];
  predictedAirtimeMs: number;
  expiresAtMs: number;
  automatic: boolean;
  replaceReservationIds?: readonly string[];
}

export type ReserveRollingRulesResult =
  | {
      ok: true;
      stationHourKey: string;
      reservations: RollingReservation[];
      auditPersisted: boolean;
      warning?: string;
    }
  | {
      ok: false;
      stationHourKey: string;
      failedRuleIds: string[];
      code: 'text_policy_failed' | 'audit_unavailable';
      stage: 'text-policy' | 'audit';
      message: string;
      retainedReservations: RollingReservation[];
    };

function mergeAuditWarnings(
  ...warnings: Array<string | undefined>
): string | undefined {
  const unique = [...new Set(warnings.filter(
    (warning): warning is string => Boolean(warning),
  ))];
  return unique.length ? unique.join('; ') : undefined;
}

function manualRollingAuditFallback(
  stationHourKey: string,
  reservations: RollingReservation[],
  message: string,
): ReserveRollingRulesResult {
  return {
    ok: true,
    stationHourKey,
    reservations,
    auditPersisted: false,
    warning: `${message}; operator-triggered speech may continue unaudited`,
  };
}

function reservationEvent(
  reservation: RollingReservation,
  atMs: number,
): VoiceAuditEvent {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    type: 'voice.policy_reserved',
    atMs,
    auditId: reservation.auditId,
    ...(reservation.traceId ? { traceId: reservation.traceId } : {}),
    ...(reservation.candidateId ? { candidateId: reservation.candidateId } : {}),
    ...(reservation.voiceId ? { voiceId: reservation.voiceId } : {}),
    stationHourKey: reservation.stationHourKey,
    payload: {
      reservationId: reservation.reservationId,
      ruleId: reservation.ruleId,
      value: reservation.value,
      stationHourKey: reservation.stationHourKey,
      expiresAtMs: reservation.expiresAtMs,
    },
  };
}

function sameReservationOwner(
  reservation: RollingReservation,
  request: ReserveRollingRulesRequest,
): boolean {
  return (
    reservation.auditId === request.auditId
    && reservation.traceId === request.traceId
    && reservation.candidateId === request.candidateId
    && reservation.voiceId === request.voiceId
  );
}

function reservationEventMatches(
  event: Extract<VoiceAuditEvent, { type: 'voice.policy_reserved' }>,
  reservation: RollingReservation,
): boolean {
  return (
    event.auditId === reservation.auditId
    && event.traceId === reservation.traceId
    && event.candidateId === reservation.candidateId
    && event.voiceId === reservation.voiceId
    && event.stationHourKey === reservation.stationHourKey
    && event.payload.reservationId === reservation.reservationId
    && event.payload.ruleId === reservation.ruleId
    && event.payload.value === reservation.value
    && event.payload.stationHourKey === reservation.stationHourKey
    && event.payload.expiresAtMs === reservation.expiresAtMs
  );
}

async function ensureReservationEvidence(
  reservations: readonly RollingReservation[],
  events: VoiceAuditEvent[],
  automatic: boolean,
): Promise<
  | { ok: true; auditPersisted: boolean; warning?: string }
  | { ok: false; message: string }
> {
  let auditPersisted = true;
  let warning: string | undefined;
  for (const reservation of reservations) {
    const existing = events.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.policy_reserved' }> =>
        event.type === 'voice.policy_reserved'
        && event.payload.reservationId === reservation.reservationId,
    );
    if (
      existing.length > 1
      || existing.some((event) => !reservationEventMatches(event, reservation))
    ) {
      throw new Error(
        `rolling reservation evidence collision: ${reservation.reservationId}`,
      );
    }
    if (existing.length === 1) continue;
    const event = reservationEvent(reservation, reservation.createdAtMs);
    const persisted = await appendPreAir(event, { automatic });
    if (!persisted.ok) return { ok: false, message: persisted.message };
    auditPersisted = auditPersisted && persisted.auditPersisted;
    if (!persisted.auditPersisted) {
      warning = mergeAuditWarnings(warning, persisted.warning);
    }
    if (persisted.auditPersisted) events.push(event);
  }
  return {
    ok: true,
    auditPersisted,
    ...(warning ? { warning } : {}),
  };
}

async function repairReservationEvidenceDirect(
  reservations: readonly RollingReservation[],
  events: VoiceAuditEvent[],
): Promise<number> {
  let repaired = 0;
  for (const reservation of reservations) {
    const existing = events.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.policy_reserved' }> =>
        event.type === 'voice.policy_reserved'
        && event.payload.reservationId === reservation.reservationId,
    );
    if (
      existing.length > 1
      || existing.some((event) => !reservationEventMatches(event, reservation))
    ) {
      throw new Error(
        `rolling reservation evidence collision: ${reservation.reservationId}`,
      );
    }
    if (existing.length === 1) continue;
    const event = reservationEvent(reservation, reservation.createdAtMs);
    await appendLedgerEvent(event);
    events.push(event);
    repaired += 1;
  }
  return repaired;
}

export function repairActiveRollingReservationEvidence(): Promise<number> {
  return withRollingMutex(async () => {
    const [reservations, eventRows] = await Promise.all([
      readRollingReservations(),
      readLedgerAndSpoolEvents(),
    ]);
    return repairReservationEvidenceDirect(
      reservations,
      orderAndDedupeAuditEvents(eventRows),
    );
  });
}

function occurrenceCounts(
  rows: ReadonlyArray<{ ruleId: string; value: string; stationHourKey: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify([row.ruleId, row.value, row.stationHourKey]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sameOccurrences(
  reservations: readonly RollingReservation[],
  occurrences: ReadonlyArray<{ ruleId: string; value: string; stationHourKey: string }>,
): boolean {
  const left = occurrenceCounts(reservations);
  const right = occurrenceCounts(occurrences);
  return (
    left.size === right.size
    && [...left].every(([key, count]) => right.get(key) === count)
  );
}

function sameAuditOwner(
  event: VoiceAuditEvent,
  request: RollingReservationOwner,
): boolean {
  return (
    event.auditId === request.auditId
    && event.traceId === request.traceId
    && event.candidateId === request.candidateId
    && event.voiceId === request.voiceId
  );
}

async function reconcileReplacementReleases(
  reservationIds: ReadonlySet<string>,
  request: ReserveRollingRulesRequest,
  currentHour: string,
  events: readonly VoiceAuditEvent[],
  atMs: number,
): Promise<boolean> {
  for (const reservationId of reservationIds) {
    const reservations = events.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.policy_reserved' }> =>
        event.type === 'voice.policy_reserved'
        && event.payload.reservationId === reservationId,
    );
    if (
      reservations.length !== 1
      || reservations.some((event) =>
        !sameAuditOwner(event, request)
        || event.payload.stationHourKey === currentHour)
    ) {
      return false;
    }
    const prior = reservations[0];
    if (reservations.some((event) =>
      event.payload.ruleId !== prior.payload.ruleId
      || event.payload.value !== prior.payload.value
      || event.payload.stationHourKey !== prior.payload.stationHourKey
      || event.payload.expiresAtMs !== prior.payload.expiresAtMs)) {
      return false;
    }
    const releases = events.filter((event) =>
      event.type === 'voice.policy_released'
      && event.payload.reservationId === reservationId);
    if (releases.length > 0) {
      if (!releases.every((event) =>
        event.type === 'voice.policy_released'
        && event.payload.reason === 'recovered'
        && sameAuditOwner(event, request)
        && event.stationHourKey === prior.payload.stationHourKey)) {
        return false;
      }
      continue;
    }
    const result = await appendPostAir({
      schemaVersion: 1,
      eventId: randomUUID(),
      type: 'voice.policy_released',
      atMs,
      auditId: prior.auditId,
      ...(prior.traceId ? { traceId: prior.traceId } : {}),
      ...(prior.candidateId ? { candidateId: prior.candidateId } : {}),
      ...(prior.voiceId ? { voiceId: prior.voiceId } : {}),
      stationHourKey: prior.payload.stationHourKey,
      payload: {
        reservationId,
        reason: 'recovered',
      },
    });
    if (!result.ok) return false;
  }
  return true;
}

export function reserveRollingRules(
  request: ReserveRollingRulesRequest,
): Promise<ReserveRollingRulesResult> {
  return withRollingMutex(async () => {
    let hourKey = '1970-01-01T00+0000@UTC';
    let authoritativeReservations: RollingReservation[] = [];
    let possiblyLiveReservations: RollingReservation[] = [];
    let auditWarning: string | undefined;
    try {
    const nowMs = Date.now();
    if (
      !Number.isSafeInteger(request.predictedAirtimeMs)
      || request.predictedAirtimeMs < 0
      || !Number.isSafeInteger(request.expiresAtMs)
      || request.expiresAtMs <= Math.max(nowMs, request.predictedAirtimeMs)
    ) {
      throw new Error('rolling reservation timestamps are invalid');
    }
    hourKey = stationHourKey(
      new Date(request.predictedAirtimeMs),
      getStationTimezone(),
    );
    if (request.automatic && !(await automaticVoiceAuditAllowed())) {
      return {
        ok: false,
        stationHourKey: hourKey,
        failedRuleIds: [],
        code: 'audit_unavailable',
        stage: 'audit',
        message: 'voice audit is not ready or unhealthy; automatic speech is disabled',
        retainedReservations: [],
      };
    }
    const [eventRows, existingAll] = await Promise.all([
      readLedgerAndSpoolEvents(),
      readRollingReservations(),
    ]);
    const auditEvents = orderAndDedupeAuditEvents(eventRows);
    const history = startedHistory(auditEvents);
    const replacing = new Set(request.replaceReservationIds ?? []);
    const maxByRule = new Map(request.rules.map((rule) => [rule.id, rule.max]));
    const ownedOutsideHour = existingAll.filter((row) =>
      row.stationHourKey !== hourKey && sameReservationOwner(row, request));
    if (
      ownedOutsideHour.length > 0
      && (
        replacing.size !== ownedOutsideHour.length
        || ownedOutsideHour.some((row) => !replacing.has(row.reservationId))
      )
    ) {
      return {
        ok: false,
        stationHourKey: hourKey,
        failedRuleIds: [],
        code: 'audit_unavailable',
        stage: 'audit',
        message: 'rolling reservation identity crossed an hour without replacing its prior reservation',
        retainedReservations: ownedOutsideHour,
      };
    }
    const ownedAtHour = existingAll.filter((row) =>
      row.stationHourKey === hourKey && sameReservationOwner(row, request));
    authoritativeReservations = ownedAtHour;
    if (
      ownedAtHour.length > 0
      && !ownedAtHour.some((row) => replacing.has(row.reservationId))
    ) {
      const ownedIds = new Set(ownedAtHour.map((row) => row.reservationId));
      const retryDecision = recheckRollingRules(
        history,
        existingAll.filter((row) => !ownedIds.has(row.reservationId)),
        {
          displayText: request.displayText,
          rules: request.rules,
          stationHourKey: hourKey,
        },
        nowMs,
      );
      if (
        retryDecision.ok
        && sameOccurrences(ownedAtHour, retryDecision.occurrences)
        && ownedAtHour.every((row) =>
          row.expiresAtMs === request.expiresAtMs
          && row.max === maxByRule.get(row.ruleId))
      ) {
        const evidence = await ensureReservationEvidence(
          ownedAtHour,
          auditEvents,
          request.automatic,
        );
        if (!evidence.ok) {
          return {
            ok: false,
            stationHourKey: hourKey,
            failedRuleIds: [],
            code: 'audit_unavailable',
            stage: 'audit',
            message: evidence.message,
            retainedReservations: ownedAtHour,
          };
        }
        auditWarning = mergeAuditWarnings(auditWarning, evidence.warning);
        if (!await reconcileReplacementReleases(
          replacing,
          request,
          hourKey,
          auditEvents,
          nowMs,
        )) {
          const message =
            'cross-hour rolling reservation release evidence is unavailable';
          if (!request.automatic) {
            return manualRollingAuditFallback(
              hourKey,
              ownedAtHour,
              mergeAuditWarnings(auditWarning, message) ?? message,
            );
          }
          return {
            ok: false,
            stationHourKey: hourKey,
            failedRuleIds: [],
            code: 'audit_unavailable',
            stage: 'audit',
            message,
            retainedReservations: ownedAtHour,
          };
        }
        return {
          ok: true,
          stationHourKey: hourKey,
          reservations: ownedAtHour,
          auditPersisted: evidence.auditPersisted,
          ...(auditWarning ? { warning: auditWarning } : {}),
        };
      }
      return {
        ok: false,
        stationHourKey: hourKey,
        failedRuleIds: [],
        code: 'audit_unavailable',
        stage: 'audit',
        message: 'rolling reservation identity was reused with different content',
        retainedReservations: ownedAtHour,
      };
    }
    const replaced = existingAll.filter((row) => replacing.has(row.reservationId));
    if (
      replacing.size > 0
      && replaced.length === 0
      && ownedAtHour.length === 0
    ) {
      const retryDecision = recheckRollingRules(history, existingAll, {
        displayText: request.displayText,
        rules: request.rules,
        stationHourKey: hourKey,
      }, nowMs);
      if (
        retryDecision.ok
        && retryDecision.occurrences.length === 0
      ) {
        const reconciled = await reconcileReplacementReleases(
          replacing,
          request,
          hourKey,
          auditEvents,
          nowMs,
        );
        if (reconciled) {
          return {
            ok: true,
            stationHourKey: hourKey,
            reservations: [],
            auditPersisted: true,
          };
        }
        if (!request.automatic) {
          return manualRollingAuditFallback(
            hourKey,
            [],
            'cross-hour rolling reservation release evidence is unavailable',
          );
        }
      }
    }
    if (replacing.size > 0) {
      const invalidReplacement =
        replaced.length !== replacing.size
        || replaced.some((row) => (
          !sameReservationOwner(row, request)
          || row.stationHourKey === hourKey
        ));
      if (invalidReplacement) {
        return {
          ok: false,
          stationHourKey: hourKey,
          failedRuleIds: [],
          code: 'audit_unavailable',
          stage: 'audit',
          message: 'rolling reservation replacement is stale, unowned, or did not cross an hour',
          retainedReservations: replaced.filter((row) =>
            sameReservationOwner(row, request)),
        };
      }
    }
    const existing = existingAll.filter((row) => !replacing.has(row.reservationId));
    const decision = recheckRollingRules(history, existing, {
      displayText: request.displayText,
      rules: request.rules,
      stationHourKey: hourKey,
    }, nowMs);
    if (!decision.ok) {
      return {
        ok: false,
        stationHourKey: hourKey,
        failedRuleIds: decision.failedRuleIds,
        code: 'text_policy_failed',
        stage: 'text-policy',
        message: `station-hour policy limit reached: ${decision.failedRuleIds.join(', ')}`,
        retainedReservations: replaced,
      };
    }
    if (decision.occurrences.length === 0 && replacing.size === 0) {
      return {
        ok: true,
        stationHourKey: hourKey,
        reservations: [],
        auditPersisted: true,
      };
    }
    const created = decision.occurrences.map((occurrence): RollingReservation => ({
      ...occurrence,
      reservationId: randomUUID(),
      auditId: request.auditId,
      ...(request.traceId ? { traceId: request.traceId } : {}),
      ...(request.candidateId ? { candidateId: request.candidateId } : {}),
      voiceId: request.voiceId,
      max: maxByRule.get(occurrence.ruleId) ?? 0,
      expiresAtMs: request.expiresAtMs,
      createdAtMs: nowMs,
    }));
    possiblyLiveReservations = [...replaced, ...created];
    let auditPersisted = true;
    if (replaced.length > 0) {
      const priorEvidence = await ensureReservationEvidence(
        replaced,
        auditEvents,
        request.automatic,
      );
      if (!priorEvidence.ok) {
        return {
          ok: false,
          stationHourKey: hourKey,
          failedRuleIds: [],
          code: 'audit_unavailable',
          stage: 'audit',
          message: priorEvidence.message,
          retainedReservations: replaced,
        };
      }
      auditPersisted = auditPersisted && priorEvidence.auditPersisted;
      auditWarning = mergeAuditWarnings(auditWarning, priorEvidence.warning);
    }
    await writeRollingReservations([...existing, ...created]);
    authoritativeReservations = created;

    for (const reservation of created) {
      const persisted: PreAirAuditResult = await appendPreAir(
        reservationEvent(reservation, nowMs),
        { automatic: request.automatic },
      );
      if (!persisted.ok) {
        // Keep the published IDs authoritative. A retry can then append only
        // the missing evidence instead of creating a second set of reserve
        // events that would all correlate with one later voice.started event.
        return {
          ok: false,
          stationHourKey: hourKey,
          failedRuleIds: [],
          code: 'audit_unavailable',
          stage: 'audit',
          message: persisted.message,
          retainedReservations: created,
        };
      }
      auditPersisted = auditPersisted && persisted.auditPersisted;
      if (!persisted.auditPersisted) {
        auditWarning = mergeAuditWarnings(auditWarning, persisted.warning);
      }
    }
    // Re-reservation is one atomic file transition. Its old audit rows are
    // closed only after the replacement exists durably.
    if (replacing.size) {
      const released = await appendReleaseEvents(replaced, 'recovered', nowMs);
      if (released.size !== replaced.length) {
        // Keep the replacement file and IDs authoritative. The idempotent
        // retry path reconciles any missing release evidence for the old IDs.
        const message = 'cross-hour rolling reservation audit could not be committed';
        if (!request.automatic) {
          return manualRollingAuditFallback(
            hourKey,
            created,
            mergeAuditWarnings(auditWarning, message) ?? message,
          );
        }
        return {
          ok: false,
          stationHourKey: hourKey,
          failedRuleIds: [],
          code: 'audit_unavailable',
          stage: 'audit',
          message,
          retainedReservations: created,
        };
      }
    }
    return {
      ok: true,
      stationHourKey: hourKey,
      reservations: created,
      auditPersisted,
      ...(auditWarning ? { warning: auditWarning } : {}),
    };
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      const message = redactVoiceAuditError(
        `rolling audit storage unavailable: ${detail}`,
      );
      await latchVoiceAuditUnhealthy(message);
      logVoiceAuditError(message);
      let retainedReservations = [
        ...new Map(
          [...authoritativeReservations, ...possiblyLiveReservations]
            .map((reservation) => [reservation.reservationId, reservation]),
        ).values(),
      ];
      try {
        retainedReservations = (await readRollingReservations()).filter((reservation) =>
          sameReservationOwner(reservation, request));
      } catch {
        // The union above contains every ID that may have reached rename when
        // authoritative state cannot itself be re-read.
      }
      if (!request.automatic) {
        return manualRollingAuditFallback(
          hourKey,
          retainedReservations,
          mergeAuditWarnings(auditWarning, message) ?? message,
        );
      }
      return {
        ok: false,
        stationHourKey: hourKey,
        failedRuleIds: [],
        code: 'audit_unavailable',
        stage: 'audit',
        message,
        retainedReservations,
      };
    }
  });
}

async function appendReleaseEvents(
  reservations: readonly RollingReservation[],
  reason: 'started' | 'dropped' | 'expired' | 'recovered',
  atMs: number,
): Promise<Set<string>> {
  const existingEvents = orderAndDedupeAuditEvents(await readLedgerAndSpoolEvents());
  const released = new Set<string>();
  for (const reservation of reservations) {
    const releases = existingEvents.filter(
      (event): event is Extract<VoiceAuditEvent, { type: 'voice.policy_released' }> =>
        event.type === 'voice.policy_released'
        && event.payload.reservationId === reservation.reservationId,
    );
    if (releases.length > 0) {
      const ownerMatches = releases.every((event) =>
        event.type === 'voice.policy_released'
        && event.auditId === reservation.auditId
        && event.traceId === reservation.traceId
        && event.candidateId === reservation.candidateId
        && event.voiceId === reservation.voiceId
        && event.stationHourKey === reservation.stationHourKey);
      const reasons = new Set(releases.map((event) => event.payload.reason));
      if (!ownerMatches || reasons.size !== 1) {
        throw new Error(
          `rolling reservation release evidence collision: ${reservation.reservationId}`,
        );
      }
      // A durable terminal reason wins if a prior multi-release attempt
      // committed this ID before another ID failed.
      released.add(reservation.reservationId);
      continue;
    }
    const event: VoiceAuditEvent = {
      schemaVersion: 1,
      eventId: randomUUID(),
      type: 'voice.policy_released',
      atMs,
      auditId: reservation.auditId,
      ...(reservation.traceId ? { traceId: reservation.traceId } : {}),
      ...(reservation.candidateId ? { candidateId: reservation.candidateId } : {}),
      ...(reservation.voiceId ? { voiceId: reservation.voiceId } : {}),
      stationHourKey: reservation.stationHourKey,
      payload: {
        reservationId: reservation.reservationId,
        reason,
      },
    };
    const result = await appendPostAir(event);
    if (result.ok) {
      existingEvents.push(event);
      released.add(reservation.reservationId);
    }
  }
  return released;
}

function hasCorrelatedTerminalEvent(
  events: readonly VoiceAuditEvent[],
  reservation: Extract<VoiceAuditEvent, { type: 'voice.policy_reserved' }>,
  owner: RollingReservationOwner,
  reason: 'started' | 'dropped',
  atMs: number,
): boolean {
  return events.some((event) =>
    event.type === (reason === 'started' ? 'voice.started' : 'voice.dropped')
    && sameAuditOwner(event, owner)
    && event.stationHourKey === reservation.stationHourKey
    && event.atMs >= reservation.atMs
    && event.atMs <= atMs);
}

export interface ReleaseRollingRulesInput extends RollingReservationOwner {
  reservationIds: readonly string[];
  stationHourKey: string;
  reason: 'started' | 'dropped';
  atMs?: number;
}

export function releaseRollingRules(input: ReleaseRollingRulesInput): Promise<number> {
  return withRollingMutex(async () => {
    try {
    const ids = new Set(input.reservationIds);
    if (ids.size === 0 || ids.size !== input.reservationIds.length) return 0;
    if (!stationHourKeySchema.safeParse(input.stationHourKey).success) return 0;
    const atMs = input.atMs ?? Date.now();
    if (!Number.isSafeInteger(atMs) || atMs < 0) return 0;
    const [all, eventRows] = await Promise.all([
      readRollingReservations(),
      readLedgerAndSpoolEvents(),
    ]);
    const events = orderAndDedupeAuditEvents(eventRows);
    const activeById = new Map(
      all.map((row) => [row.reservationId, row] as const),
    );
    const ownedActive = all.filter((row) =>
      row.stationHourKey === input.stationHourKey
      && row.auditId === input.auditId
      && row.traceId === input.traceId
      && row.candidateId === input.candidateId
      && row.voiceId === input.voiceId);
    if (ownedActive.some((row) => !ids.has(row.reservationId))) return 0;
    const releasable: RollingReservation[] = [];
    let alreadyReleased = 0;
    for (const reservationId of ids) {
      const evidence = events.filter(
        (event): event is Extract<VoiceAuditEvent, { type: 'voice.policy_reserved' }> =>
          event.type === 'voice.policy_reserved'
          && event.payload.reservationId === reservationId,
      );
      if (
        evidence.length !== 1
        || !sameAuditOwner(evidence[0], input)
        || evidence[0].stationHourKey !== input.stationHourKey
      ) {
        throw new Error('unowned or unknown rolling reservation');
      }
      const reservation = activeById.get(reservationId);
      if (reservation && !reservationEventMatches(evidence[0], reservation)) {
        throw new Error(`rolling reservation state/evidence mismatch: ${reservationId}`);
      }
      const releases = events.filter(
        (event): event is Extract<VoiceAuditEvent, { type: 'voice.policy_released' }> =>
          event.type === 'voice.policy_released'
          && event.payload.reservationId === reservationId,
      );
      if (releases.length > 0) {
        const reasons = new Set(releases.map((event) => event.payload.reason));
        if (
          reasons.size !== 1
          || releases.some((event) =>
            !sameAuditOwner(event, input)
            || event.stationHourKey !== input.stationHourKey)
        ) {
          throw new Error(`rolling reservation release collision: ${reservationId}`);
        }
        const existingReason = releases[0].payload.reason;
        if (
          (existingReason === 'started' || existingReason === 'dropped')
          && !hasCorrelatedTerminalEvent(
            events,
            evidence[0],
            input,
            existingReason,
            atMs,
          )
        ) {
          throw new Error(`rolling reservation release has no terminal event: ${reservationId}`);
        }
        if (reservation) releasable.push(reservation);
        else alreadyReleased += 1;
        continue;
      }
      if (
        !reservation
        || !hasCorrelatedTerminalEvent(
          events,
          evidence[0],
          input,
          input.reason,
          atMs,
        )
      ) {
        return 0;
      }
      releasable.push(reservation);
    }
    const released = await appendReleaseEvents(
      releasable,
      input.reason,
      atMs,
    );
    if (released.size > 0) {
      await writeRollingReservations(
        all.filter((row) => !released.has(row.reservationId)),
      );
    }
    return alreadyReleased + released.size;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      const message = redactVoiceAuditError(
        `rolling reservation release failed: ${detail}`,
      );
      await latchVoiceAuditUnhealthy(message);
      logVoiceAuditError(message);
      return 0;
    }
  });
}

export function recoverExpiredRollingReservations(input: {
  nowMs?: number;
  referencesComplete: boolean;
  queueReservationIds?: ReadonlySet<string>;
  handoffReservationIds?: ReadonlySet<string>;
  arbiterLockReservationIds?: ReadonlySet<string>;
}): Promise<number> {
  return withRollingMutex(async () => {
    try {
    if (!input.referencesComplete) return 0;
    const nowMs = input.nowMs ?? Date.now();
    const [all, eventRows] = await Promise.all([
      readRollingReservations(),
      readLedgerAndSpoolEvents(),
    ]);
    const events = orderAndDedupeAuditEvents(eventRows);
    await repairReservationEvidenceDirect(all, events);
    const referenced = new Set([
      ...(input.queueReservationIds ?? []),
      ...(input.handoffReservationIds ?? []),
      ...(input.arbiterLockReservationIds ?? []),
    ]);
    const byReason = {
      started: [] as RollingReservation[],
      dropped: [] as RollingReservation[],
      expired: [] as RollingReservation[],
    };
    for (const reservation of all) {
      const evidence = events.find(
        (event): event is Extract<VoiceAuditEvent, { type: 'voice.policy_reserved' }> =>
          event.type === 'voice.policy_reserved'
          && event.payload.reservationId === reservation.reservationId,
      );
      if (!evidence) {
        throw new Error(`missing repaired reservation evidence: ${reservation.reservationId}`);
      }
      const started = hasCorrelatedTerminalEvent(
        events,
        evidence,
        reservation,
        'started',
        nowMs,
      );
      const dropped = hasCorrelatedTerminalEvent(
        events,
        evidence,
        reservation,
        'dropped',
        nowMs,
      );
      if (started && dropped) {
        throw new Error(`conflicting reservation terminal events: ${reservation.reservationId}`);
      }
      if (started) byReason.started.push(reservation);
      else if (dropped) byReason.dropped.push(reservation);
      else if (
        reservation.expiresAtMs <= nowMs
        && !referenced.has(reservation.reservationId)
      ) {
        byReason.expired.push(reservation);
      }
    }
    const released = new Set<string>();
    for (const reason of ['started', 'dropped', 'expired'] as const) {
      const committed = await appendReleaseEvents(byReason[reason], reason, nowMs);
      for (const reservationId of committed) released.add(reservationId);
    }
    if (released.size > 0) {
      await writeRollingReservations(
        all.filter((row) => !released.has(row.reservationId)),
      );
    }
    return released.size;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      const message = redactVoiceAuditError(
        `rolling reservation recovery failed: ${detail}`,
      );
      await latchVoiceAuditUnhealthy(message);
      logVoiceAuditError(message);
      return 0;
    }
  });
}

export function resetRollingPolicyForTests(): void {
  rollingTail = Promise.resolve();
}
