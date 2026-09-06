// Public controller-only surface for durable rendered-voice evidence.

import * as settings from '../../settings.js';
import {
  automaticVoiceAuditAllowed,
  beginVoiceAuditRecovery,
  completeVoiceAuditRecovery,
  invalidateVoiceAuditRecovery,
  latchVoiceAuditUnhealthy,
  logVoiceAuditError,
  probeVoiceAuditSinks,
  readVoiceAuditHealth,
  redactVoiceAuditError,
  runVoiceAuditHealthProbe,
} from './health.js';
import { pruneVoiceAuditEvents } from './retention.js';
import { repairActiveRollingReservationEvidence } from './rolling-policy.js';
import { drainVoiceAuditSpool } from './spool.js';
import {
  ensureVoiceAuditEventIndex,
  readLedgerEvents,
} from './ledger.js';

export * from './golden.js';
export * from './health.js';
export * from './ledger.js';
export * from './retention.js';
export * from './rolling-policy.js';
export * from './spool.js';
export * from './types.js';

function broadcastQaEnabled(): boolean {
  try {
    return settings.get()?.tts?.broadcastQa?.enabled === true;
  } catch {
    return false;
  }
}

let starting: Promise<VoiceAuditStartResult> | null = null;
let startingGeneration = -1;
let integrityChecked = false;
let lifecycleGeneration = 0;

export type VoiceAuditStartResult =
  | { ok: true; started: true; drained: number }
  | { ok: true; started: false; drained: 0 }
  | { ok: false; started: true; drained: number; message: string };

const voiceAuditStopped = (): VoiceAuditStartResult => ({
  ok: true,
  started: false,
  drained: 0,
});

export function ensureVoiceAuditStarted(
  options: { enabled?: boolean } = {},
): Promise<VoiceAuditStartResult> {
  const enabled = options.enabled ?? broadcastQaEnabled();
  if (!enabled) return Promise.resolve(voiceAuditStopped());
  const requestGeneration = lifecycleGeneration;
  const explicitlyEnabled = options.enabled === true;
  const requestStillCurrent = (): boolean =>
    lifecycleGeneration === requestGeneration
    && (explicitlyEnabled || broadcastQaEnabled());
  if (starting) {
    if (startingGeneration === lifecycleGeneration) return starting;
    return starting.then(
      () => requestStillCurrent()
        ? ensureVoiceAuditStarted(options)
        : voiceAuditStopped(),
      () => requestStillCurrent()
        ? ensureVoiceAuditStarted(options)
        : voiceAuditStopped(),
    );
  }
  const startGeneration = lifecycleGeneration;
  const recoveryGeneration = beginVoiceAuditRecovery();
  const run = (async (): Promise<VoiceAuditStartResult> => {
    const lifecycleStillCurrent = (): boolean =>
      lifecycleGeneration === startGeneration
      && (explicitlyEnabled || broadcastQaEnabled());
    if (!lifecycleStillCurrent()) return voiceAuditStopped();
    let drained = 0;
    let recoveryError: Error | null = null;
    let recoveryStage = 'spool drain';
    try {
      drained = (await drainVoiceAuditSpool()).drained;
    } catch (err) {
      recoveryError = err instanceof Error ? err : new Error(String(err));
    }
    if (!lifecycleStillCurrent()) return voiceAuditStopped();
    if (!recoveryError) {
      recoveryStage = 'ledger integrity';
      try {
        const health = await readVoiceAuditHealth();
        if (!integrityChecked || health.auditUnhealthy) {
          await readLedgerEvents();
        recoveryStage = 'rolling reservation evidence';
        await repairActiveRollingReservationEvidence();
        recoveryStage = 'event ID index';
        await ensureVoiceAuditEventIndex();
        if (lifecycleGeneration === startGeneration) integrityChecked = true;
        }
      } catch (err) {
        recoveryError = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (!lifecycleStillCurrent()) return voiceAuditStopped();

    if (recoveryError) {
      const failure = redactVoiceAuditError(
        `voice audit ${recoveryStage} failed: ${recoveryError.message}`,
      );
      await latchVoiceAuditUnhealthy(failure);
      logVoiceAuditError(failure);
      // Probe both filesystems for diagnostics, but do not clear a latch while
      // a spool or ledger-integrity recovery failure remains unresolved.
      const sinks = await probeVoiceAuditSinks();
      const details = [
        sinks.ledger.ok ? null : `ledger: ${sinks.ledger.error}`,
        sinks.spool.ok ? null : `spool: ${sinks.spool.error}`,
      ].filter(Boolean);
      const message = [
        failure,
        ...details,
      ].join('; ');
      await latchVoiceAuditUnhealthy(message);
      return { ok: false, started: true, drained, message };
    }

    const probe = await runVoiceAuditHealthProbe(Date.now(), {
      recoveryComplete: true,
    });
    if (!lifecycleStillCurrent()) return voiceAuditStopped();
    if (!probe.healthy) {
      const message = [
        probe.ledger.ok ? null : `ledger: ${probe.ledger.error}`,
        probe.spool.ok ? null : `spool: ${probe.spool.error}`,
      ].filter(Boolean).join('; ') || 'voice audit health file is not durable';
      logVoiceAuditError(`startup health probe failed: ${message}`);
      return { ok: false, started: true, drained, message };
    }
    if (!(await completeVoiceAuditRecovery(recoveryGeneration))) {
      const message = 'voice audit lifecycle changed while recovery was in progress';
      return { ok: false, started: true, drained, message };
    }
    return { ok: true, started: true, drained };
  })();
  starting = run.finally(() => {
    starting = null;
    startingGeneration = -1;
  });
  startingGeneration = startGeneration;
  return starting;
}

export async function runVoiceAuditMinute(
  options: { enabled?: boolean } = {},
): Promise<VoiceAuditStartResult> {
  const enabled = options.enabled ?? broadcastQaEnabled();
  if (!enabled) return voiceAuditStopped();
  if (
    starting
    || !integrityChecked
    || !(await automaticVoiceAuditAllowed())
  ) {
    return ensureVoiceAuditStarted(options);
  }
  const minuteGeneration = lifecycleGeneration;
  const explicitlyEnabled = options.enabled === true;
  const lifecycleStillCurrent = (): boolean =>
    lifecycleGeneration === minuteGeneration
    && (explicitlyEnabled || broadcastQaEnabled());
  let drained = 0;
  try {
    drained = (await drainVoiceAuditSpool()).drained;
  } catch (err: unknown) {
    if (!lifecycleStillCurrent()) return voiceAuditStopped();
    const detail = err instanceof Error ? err.message : 'unknown error';
    const message = redactVoiceAuditError(
      `voice audit routine spool drain failed: ${detail}`,
    );
    await latchVoiceAuditUnhealthy(message);
    logVoiceAuditError(message);
    return { ok: false, started: true, drained, message };
  }
  if (!lifecycleStillCurrent()) return voiceAuditStopped();
  const probe = await runVoiceAuditHealthProbe(Date.now(), {
    recordHealthy: true,
  });
  if (!lifecycleStillCurrent()) return voiceAuditStopped();
  if (!probe.healthy) {
    const message = [
      probe.ledger.ok ? null : `ledger: ${probe.ledger.error}`,
      probe.spool.ok ? null : `spool: ${probe.spool.error}`,
    ].filter(Boolean).join('; ') || 'voice audit routine health probe failed';
    logVoiceAuditError(message);
    return { ok: false, started: true, drained, message };
  }
  return { ok: true, started: true, drained };
}

export async function runVoiceAuditRetention(): Promise<number> {
  if (!broadcastQaEnabled()) return 0;
  return pruneVoiceAuditEvents();
}

export function suspendVoiceAuditLifecycle(): Promise<void> {
  lifecycleGeneration += 1;
  integrityChecked = false;
  return invalidateVoiceAuditRecovery();
}

export function resetVoiceAuditLifecycleForTests(): void {
  starting = null;
  startingGeneration = -1;
  integrityChecked = false;
  lifecycleGeneration = 0;
}
