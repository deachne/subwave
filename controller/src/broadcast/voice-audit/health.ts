// Persistent fail-closed latch for the voice audit path. Music and explicit
// operator speech do not consult this latch; future automatic QA handoffs do.

import { config } from '../../config.js';
import {
  probeDurableAppendFile,
  probeDurableDirectory,
  probeDurableExclusiveFile,
  readDurableRegularFile,
  writeDurableFileAtomic,
} from '../../util/durable-file.js';
import {
  auditStringPrivacyIssue,
  voiceAuditHealthSchema,
  type VoiceAuditHealth,
} from './types.js';

const healthyDefault = (): VoiceAuditHealth => ({
  schemaVersion: 1,
  auditUnhealthy: false,
  sinceMs: null,
  reason: null,
  lastHealthyProbeAtMs: null,
  lastRender: null,
});

let memoryHealth: VoiceAuditHealth | null = null;
let healthTail: Promise<void> = Promise.resolve();
let latchGeneration = 0;
let readinessGeneration = 0;
let automaticLifecycleReady = false;
let auditLogger: (message: string) => void = (message) => {
  console.error(`[voice-audit] ${message}`);
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function redactVoiceAuditError(reason: string): string {
  const withoutStatePath = config.stateDir.length > 1
    ? reason.split(config.stateDir).join('state')
    : reason;
  const privacyIssue = auditStringPrivacyIssue(withoutStatePath);
  if (privacyIssue) {
    return `voice audit unavailable; ${privacyIssue} detail redacted`;
  }
  return withoutStatePath.slice(0, 2_000) || 'voice audit unavailable';
}

export function setVoiceAuditLogger(logger: (message: string) => void): void {
  auditLogger = logger;
}

export function logVoiceAuditError(message: string): void {
  const safeMessage = redactVoiceAuditError(message);
  try {
    auditLogger(safeMessage);
  } catch {
    console.error(`[voice-audit] ${safeMessage}`);
  }
}

function withHealthMutex<T>(fn: () => Promise<T>): Promise<T> {
  const run = healthTail.catch(() => undefined).then(fn);
  healthTail = run.then(() => undefined, () => undefined);
  return run;
}

async function readDiskHealth(): Promise<VoiceAuditHealth> {
  try {
    const result = voiceAuditHealthSchema.safeParse(
      JSON.parse(
        (await readDurableRegularFile(config.voiceAudit.healthFile)).toString('utf8'),
      ),
    );
    if (!result.success) {
      return {
        ...healthyDefault(),
        auditUnhealthy: true,
        sinceMs: Date.now(),
        reason: redactVoiceAuditError(
          `invalid health.json: ${result.error.issues[0]?.message ?? 'schema mismatch'}`,
        ),
      };
    }
    return result.data;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return healthyDefault();
    return {
      ...healthyDefault(),
      auditUnhealthy: true,
      sinceMs: Date.now(),
      reason: redactVoiceAuditError(
        `cannot read health.json: ${errorMessage(err, 'unknown error')}`,
      ),
    };
  }
}

async function readVoiceAuditHealthUnlocked(): Promise<VoiceAuditHealth> {
  const disk = await readDiskHealth();
  // A latch that could not itself be persisted must still survive in memory
  // for this process. Disk may only strengthen it, never clear it.
  if (memoryHealth?.auditUnhealthy && !disk.auditUnhealthy) return memoryHealth;
  memoryHealth = disk;
  return disk;
}

export function readVoiceAuditHealth(): Promise<VoiceAuditHealth> {
  return withHealthMutex(readVoiceAuditHealthUnlocked);
}

async function persistHealth(next: VoiceAuditHealth): Promise<boolean> {
  const parsed = voiceAuditHealthSchema.safeParse(next);
  if (!parsed.success) return false;
  memoryHealth = parsed.data;
  try {
    await writeDurableFileAtomic(
      config.voiceAudit.healthFile,
      `${JSON.stringify(parsed.data, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

async function latchVoiceAuditUnhealthyUnlocked(
  reason: string,
  nowMs = Date.now(),
): Promise<VoiceAuditHealth> {
  automaticLifecycleReady = false;
  readinessGeneration += 1;
  latchGeneration += 1;
  const current = await readVoiceAuditHealthUnlocked();
  const next: VoiceAuditHealth = {
    ...current,
    auditUnhealthy: true,
    sinceMs: current.auditUnhealthy && current.sinceMs !== null
      ? current.sinceMs
      : nowMs,
    reason: redactVoiceAuditError(reason),
  };
  await persistHealth(next);
  return next;
}

export function latchVoiceAuditUnhealthy(
  reason: string,
  nowMs = Date.now(),
): Promise<VoiceAuditHealth> {
  automaticLifecycleReady = false;
  readinessGeneration += 1;
  return withHealthMutex(() => latchVoiceAuditUnhealthyUnlocked(reason, nowMs));
}

export function invalidateVoiceAuditRecovery(): Promise<void> {
  automaticLifecycleReady = false;
  readinessGeneration += 1;
  return withHealthMutex(async () => {
    latchGeneration += 1;
  });
}

export function beginVoiceAuditRecovery(): number {
  automaticLifecycleReady = false;
  readinessGeneration += 1;
  return readinessGeneration;
}

export function completeVoiceAuditRecovery(
  expectedGeneration: number,
): Promise<boolean> {
  return withHealthMutex(async () => {
    if (readinessGeneration !== expectedGeneration) return false;
    if ((await readVoiceAuditHealthUnlocked()).auditUnhealthy) return false;
    automaticLifecycleReady = true;
    return true;
  });
}

async function clearVoiceAuditLatch(
  nowMs: number,
  expectedGeneration: number,
): Promise<boolean> {
  return withHealthMutex(async () => {
    if (latchGeneration !== expectedGeneration) return false;
    const current = await readVoiceAuditHealthUnlocked();
    const next: VoiceAuditHealth = {
      ...current,
      auditUnhealthy: false,
      sinceMs: null,
      reason: null,
      lastHealthyProbeAtMs: nowMs,
    };
    if (await persistHealth(next)) return true;
    memoryHealth = {
      ...current,
      auditUnhealthy: true,
      sinceMs: current.sinceMs ?? nowMs,
      reason: 'health.json could not persist a successful audit probe',
    };
    return false;
  });
}

async function recordHealthyVoiceAuditProbe(
  nowMs: number,
  expectedGeneration: number,
): Promise<boolean> {
  return withHealthMutex(async () => {
    if (latchGeneration !== expectedGeneration) return false;
    const current = await readVoiceAuditHealthUnlocked();
    if (current.auditUnhealthy) return false;
    if (await persistHealth({
      ...current,
      lastHealthyProbeAtMs: nowMs,
    })) {
      return true;
    }
    await latchVoiceAuditUnhealthyUnlocked(
      'health.json could not persist a routine audit probe',
      nowMs,
    );
    return false;
  });
}

export interface VoiceAuditSinkProbe {
  ledger: { ok: boolean; error?: string };
  spool: { ok: boolean; error?: string };
}

async function probeOne(task: () => Promise<void>): Promise<{ ok: boolean; error?: string }> {
  try {
    await task();
    return { ok: true };
  } catch (err: unknown) {
    return {
      ok: false,
      error: redactVoiceAuditError(errorMessage(err, 'durability probe failed')),
    };
  }
}

export async function probeVoiceAuditSinks(
  atMs = Date.now(),
): Promise<VoiceAuditSinkProbe> {
  const ledgerPath =
    `${config.voiceAudit.eventsPrefix}${new Date(atMs).toISOString().slice(0, 10)}.jsonl`;
  const [ledger, spool] = await Promise.all([
    probeOne(async () => {
      await probeDurableAppendFile(ledgerPath);
      await probeDurableDirectory(config.voiceAudit.dir);
    }),
    probeOne(() => probeDurableExclusiveFile(config.voiceAudit.spoolDir)),
  ]);
  return { ledger, spool };
}

export async function runVoiceAuditHealthProbe(
  nowMs = Date.now(),
  {
    recoveryComplete = false,
    recordHealthy = false,
  }: {
    recoveryComplete?: boolean;
    recordHealthy?: boolean;
  } = {},
): Promise<VoiceAuditSinkProbe & { healthy: boolean }> {
  const probeGeneration = latchGeneration;
  const probe = await probeVoiceAuditSinks(nowMs);
  const sinksHealthy = probe.ledger.ok && probe.spool.ok;
  if (sinksHealthy) {
    if (!recoveryComplete) {
      if (recordHealthy) {
        return {
          ...probe,
          healthy: await recordHealthyVoiceAuditProbe(nowMs, probeGeneration),
        };
      }
      return {
        ...probe,
        healthy: !(await readVoiceAuditHealth()).auditUnhealthy,
      };
    }
    const persisted = await clearVoiceAuditLatch(nowMs, probeGeneration);
    if (persisted) return { ...probe, healthy: true };
    // Either health.json itself could not be committed, or a newer failure
    // latched while this probe was in flight. Both paths already retain an
    // unhealthy state and must not be overwritten by this stale success.
    return { ...probe, healthy: false };
  }
  const reasons = [
    probe.ledger.ok ? null : `ledger: ${probe.ledger.error}`,
    probe.spool.ok ? null : `spool: ${probe.spool.error}`,
  ].filter(Boolean);
  const reason = reasons.length
    ? `voice audit sink probe failed (${reasons.join('; ')})`
    : 'voice audit health file is not durable';
  await latchVoiceAuditUnhealthy(reason, nowMs);
  return { ...probe, healthy: false };
}

export interface VoiceAuditAdmission {
  allowed: boolean;
  generation: number;
  readinessGeneration: number;
}

export function automaticVoiceAuditAdmission(): Promise<VoiceAuditAdmission> {
  return withHealthMutex(async () => ({
    allowed:
      automaticLifecycleReady
      && !(await readVoiceAuditHealthUnlocked()).auditUnhealthy,
    generation: latchGeneration,
    readinessGeneration,
  }));
}

export function automaticVoiceAuditAdmissionStillValid(
  admission: VoiceAuditAdmission,
): Promise<boolean> {
  return withHealthMutex(async () =>
    admission.generation === latchGeneration
    && admission.readinessGeneration === readinessGeneration
    && automaticLifecycleReady
    && !(await readVoiceAuditHealthUnlocked()).auditUnhealthy);
}

export async function automaticVoiceAuditAllowed(): Promise<boolean> {
  return (await automaticVoiceAuditAdmission()).allowed;
}

export async function recordVoiceAuditRender(
  render: NonNullable<VoiceAuditHealth['lastRender']>,
): Promise<boolean> {
  return withHealthMutex(async () => {
    const current = await readVoiceAuditHealthUnlocked();
    if (await persistHealth({ ...current, lastRender: render })) return true;
    await latchVoiceAuditUnhealthyUnlocked(
      'health.json could not persist voice render health',
    );
    return false;
  });
}

export async function overlayVoiceAuditSummary<
  T extends {
    t: string | null;
    counts: { ok: number; warn: number; fail: number; skip: number } | null;
    overall: 'healthy' | 'attention' | 'critical' | null;
  },
>(summary: T, enabled: boolean): Promise<T | (T & { auditUnhealthy: true })> {
  if (!enabled) return summary;
  const health = await readVoiceAuditHealth();
  if (!health.auditUnhealthy) return summary;
  return {
    ...summary,
    counts: summary.counts
      ? { ...summary.counts, fail: Math.max(1, summary.counts.fail) }
      : { ok: 0, warn: 0, fail: 1, skip: 0 },
    overall: 'critical',
    auditUnhealthy: true,
  };
}

export function resetVoiceAuditHealthForTests(): void {
  memoryHealth = null;
  healthTail = Promise.resolve();
  latchGeneration = 0;
  readinessGeneration = 0;
  automaticLifecycleReady = false;
  auditLogger = (message) => {
    console.error(`[voice-audit] ${message}`);
  };
}
