// Durable rendered-voice audit: schemas, fsync sinks, fail-closed latch,
// rolling reservations, retention, DST keys, and golden evidence.
//
// Run: npx tsx scripts/voice-audit.test.ts

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { beforeEach } from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-voice-audit-'));
process.env.STATE_DIR = stateRoot;

const audit = await import('../src/broadcast/voice-audit/index.js');
const { config } = await import('../src/config.js');
const { checkTts } = await import('../src/doctor/checks-services.js');
const { setStationTimezone, stationHourKey } = await import('../src/time.js');
const { canonicalSha256 } = await import('../src/util/canonical-json.js');

const RENDER_SETTINGS_SNAPSHOT = {
  policy: { rules: [], replacements: [] },
  profile: { id: 'talkup', minMs: 4_000, maxMs: 12_000 },
  corrections: [],
  ttsPlan: [{ engine: 'kokoro', voice: 'bf_isabella' }],
  persona: { id: 'host', voice: 'bf_isabella' },
  rewrite: { enabled: true, model: 'test-rewrite-model' },
  legacyGainDb: 0,
};
const HOUR = '2026-09-05T14-0500@America_Winnipeg';
const PREVIOUS_HOUR = '2026-09-05T13-0500@America_Winnipeg';
const HOUR_START = Date.parse('2026-09-05T19:00:00.000Z');
const HOUR_END = HOUR_START + 60 * 60 * 1_000;
const AT = Date.parse('2026-09-05T19:10:00.000Z');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonicalHash = (value: unknown) => hash(JSON.stringify(value));

function snapshot() {
  return {
    capturedAtMs: AT,
    settingsHash: canonicalSha256(RENDER_SETTINGS_SNAPSHOT),
    policyHash: canonicalSha256(RENDER_SETTINGS_SNAPSHOT.policy),
    profileHash: canonicalSha256(RENDER_SETTINGS_SNAPSHOT.profile),
    correctionsHash: canonicalSha256(RENDER_SETTINGS_SNAPSHOT.corrections),
    ttsPlanHash: canonicalSha256(RENDER_SETTINGS_SNAPSHOT.ttsPlan),
    personaHash: canonicalSha256(RENDER_SETTINGS_SNAPSHOT.persona),
    legacyGainDb: 0,
  };
}

function audioSnapshot(stage: string) {
  return {
    stage,
    codecName: 'pcm_s16le',
    sampleRateHz: 44_100,
    channels: 1,
    durationMs: 5_000,
    loudnessLufs: -18,
    truePeakDbtp: -1.2,
    leadingSilenceMs: 80,
    trailingSilenceMs: 120,
    silenceIntervals: [],
  };
}

function attempt(status: 'accepted' | 'failed' = 'accepted') {
  const common = {
    targetKey: 'kokoro:bf_isabella',
    engine: 'kokoro',
    voice: 'bf_isabella',
    textHash: canonicalHash('Hello.'),
    targetConfigHash: hash('target'),
    startedAtMs: AT,
    endedAtMs: AT + 5_000,
  };
  if (status === 'failed') {
    return {
      ...common,
      status,
      failedStage: 'decode',
      failureCode: 'invalid_audio',
      evidence: { decoded: audioSnapshot('decoded') },
    };
  }
  return {
    ...common,
    status,
    evidence: {
      decoded: audioSnapshot('decoded'),
      temporalEdits: audioSnapshot('temporal-edits'),
      normalized: audioSnapshot('normalized'),
      final: audioSnapshot('final'),
    },
    edits: {
      leadingTrimMs: 0,
      trailingTrimMs: 0,
      pauseEdits: [],
      edgeFadeMs: 40,
      loudnormPasses: 2,
    },
  };
}

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    auditId: 'audit-1',
    artifactId: 'artifact-1',
    path: 'voice/artifacts/audit-1-deadbeef.wav',
    sha256: hash('audio'),
    displayText: 'Hello.',
    spokenText: 'Hello.',
    kind: 'link',
    profile: 'talkup',
    durationMs: 5_000,
    firstVoiceMs: 80,
    lastVoiceMs: 4_880,
    loudnessLufs: -18,
    truePeakDbtp: -1.2,
    leadingSilenceMs: 80,
    trailingSilenceMs: 120,
    internalPausesMs: [],
    engine: 'kokoro',
    voice: 'bf_isabella',
    rewriteCount: 0,
    factLocksHash: hash('facts'),
    renderSnapshot: snapshot(),
    createdAt: new Date(AT).toISOString(),
    ...overrides,
  };
}

function base(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    eventId: `${type}-${Math.random().toString(16).slice(2)}`,
    type,
    atMs: AT,
    auditId: 'audit-1',
    stationHourKey: HOUR,
    payload,
    ...overrides,
  };
}

function eventFor(type: string) {
  switch (type) {
    case 'voice.text_policy':
      return base(type, {
        outcome: 'passed',
        inputDisplayText: 'Hello.',
        inputDisplayTextHash: canonicalHash('Hello.'),
        displayText: 'Hello.',
        displayTextHash: canonicalHash('Hello.'),
        spokenTextHash: canonicalHash('Hello.'),
        passedRuleIds: [],
        failedRuleIds: [],
        replacements: [],
        factLocksHash: hash('facts'),
        renderSnapshot: snapshot(),
      });
    case 'voice.rewrite':
      return base(type, {
        count: 1,
        beforeHash: hash('before'),
        afterHash: hash('after'),
        outcome: 'passed',
        failedRuleIds: [],
      });
    case 'voice.render_attempt':
      return base(type, attempt());
    case 'voice.qa_passed':
      return base(type, {
        artifactId: 'artifact-1',
        profile: 'talkup',
        measurements: {
          durationMs: 5_000,
          firstVoiceMs: 80,
          lastVoiceMs: 4_880,
          loudnessLufs: -18,
          truePeakDbtp: -1.2,
          leadingSilenceMs: 80,
          trailingSilenceMs: 120,
          internalPausesMs: [],
        },
      });
    case 'voice.qa_failed':
      return base(type, {
        stage: 'decode',
        code: 'invalid_audio',
        attempt: attempt('failed'),
      });
    case 'voice.artifact':
      return base(type, { artifact: artifact() });
    case 'voice.policy_reserved':
      return base(type, {
        reservationId: 'reservation-1',
        ruleId: 'folks-hour',
        value: 'folks',
        stationHourKey: HOUR,
        expiresAtMs: AT + 60_000,
      }, { voiceId: 'voice-1' });
    case 'voice.policy_released':
      return base(
        type,
        { reservationId: 'reservation-1', reason: 'started' },
        { voiceId: 'voice-1' },
      );
    case 'voice.queued':
      return base(type, {
        artifactId: 'artifact-1',
        queue: 'intro',
        queuedAtMs: AT,
      }, { voiceId: 'voice-1' });
    case 'voice.started':
      return base(type, {
        artifactId: 'artifact-1',
        queue: 'intro',
        clipStartedAt: AT + 1_000,
        audibleStartedAt: AT + 1_080,
        measured: true,
      }, { voiceId: 'voice-1' });
    case 'voice.ended':
      return base(type, {
        artifactId: 'artifact-1',
        clipEndedAt: AT + 6_000,
        audibleEndedAt: AT + 5_880,
        measured: true,
        reason: 'natural',
      }, { voiceId: 'voice-1' });
    case 'voice.dropped':
      return base(type, { code: 'stale', stage: 'airtime' });
    default:
      throw new Error(`missing fixture for ${type}`);
  }
}

beforeEach(() => {
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  rmSync(join(stateRoot, 'voice'), { recursive: true, force: true });
  rmSync(join(stateRoot, 'capabilities.json'), { force: true });
  rmSync(join(stateRoot, 'settings.json'), { force: true });
  audit.resetVoiceAuditHealthForTests();
  audit.resetVoiceAuditLedgerForTests();
  audit.resetVoiceAuditSpoolForTests();
  audit.resetRollingPolicyForTests();
  audit.resetVoiceAuditLifecycleForTests();
  setStationTimezone('America/Winnipeg');
});

async function enableAutomaticAudit(): Promise<void> {
  const started = await audit.ensureVoiceAuditStarted({ enabled: true });
  assert.equal(started.ok, true);
}

test('disabled startup creates no audit directory or event', async () => {
  const result = await audit.ensureVoiceAuditStarted({ enabled: false });
  assert.deepEqual(result, { ok: true, started: false, drained: 0 });
  assert.equal(existsSync(config.voiceAudit.dir), false);
});

test('all audit discriminators validate and replay from complete JSONL records', async () => {
  for (const type of audit.VOICE_AUDIT_TYPE_VALUES) {
    const event = eventFor(type);
    assert.equal(audit.voiceAuditEventSchema.safeParse(event).success, true, type);
    await audit.appendLedgerEvent(event);
  }
  const events = await audit.readLedgerEvents();
  assert.deepEqual(events.map((event) => event.type), audit.VOICE_AUDIT_TYPE_VALUES);
  const dayFile = audit.voiceAuditEventPath(AT);
  const body = readFileSync(dayFile, 'utf8');
  assert.equal(body.endsWith('\n'), true);
  assert.equal(body.trimEnd().split('\n').length, audit.VOICE_AUDIT_TYPE_VALUES.length);
});

test('adversarial events are rejected before ledger or spool creation', async () => {
  const provenance = {
    schemaVersion: 1 as const,
    skillId: 'weather',
    sourceId: 'ec',
    attribution: 'EC',
    fetchedAt: new Date(AT).toISOString(),
    expiresAt: new Date(AT + 60_000).toISOString(),
    entityKey: 'melita',
    sourceRevision: 'r1',
    payloadHash: hash('payload'),
    candidateRevision: 'c1',
    revalidationKey: 'r1',
  };
  const bad = [
    { ...eventFor('voice.started'), type: 'voice.future' },
    { ...eventFor('voice.started'), atMs: AT + 0.5 },
    base('voice.render_attempt', {
      ...attempt(),
      evidence: { decoded: audioSnapshot('decoded') },
    }),
    base('voice.render_attempt', {
      ...attempt('failed'),
      failedStage: 'render',
      evidence: { final: audioSnapshot('final') },
    }),
    base('voice.render_attempt', {
      ...attempt(),
      evidence: {
        ...(attempt() as any).evidence,
        final: {
          ...audioSnapshot('final'),
          leadingSilenceMs: 5_001,
        },
      },
    }),
    base('voice.qa_failed', {
      stage: 'decode',
      code: 'invalid_audio',
      attempt: attempt(),
    }),
    base('voice.text_policy', {
      ...(eventFor('voice.text_policy') as any).payload,
      spokenTextHash: undefined,
    }),
    { ...eventFor('voice.queued'), voiceId: undefined },
    { ...eventFor('voice.policy_released'), voiceId: undefined },
    base('voice.started', {
      ...(eventFor('voice.started') as any).payload,
      audibleStartedAt: AT,
    }, { voiceId: 'voice-1' }),
    base('voice.ended', {
      ...(eventFor('voice.ended') as any).payload,
      audibleEndedAt: undefined,
      measured: true,
    }, { voiceId: 'voice-1' }),
    base('voice.ended', {
      ...(eventFor('voice.ended') as any).payload,
      audibleEndedAt: AT + 10_000,
    }, { voiceId: 'voice-1' }),
    base('voice.artifact', {
      artifact: artifact({ path: '/Users/operator/secret.wav' }),
    }),
    base('voice.artifact', {
      artifact: artifact({ firstVoiceMs: 5_001 }),
    }),
    base('voice.artifact', {
      artifact: { ...artifact(), apiKey: 'secret-value' },
    }),
    base('voice.artifact', {
      artifact: { ...artifact(), accessKey: 'secret-value' },
    }),
    base('voice.artifact', {
      artifact: { ...artifact(), private_key: 'secret-value' },
    }),
    base('voice.artifact', {
      artifact: artifact({ auditId: 'different-audit' }),
    }),
    base('voice.artifact', {
      artifact: artifact({
        provenanceHash: hash('wrong-provenance'),
        sourceExpiresAt: provenance.expiresAt,
      }),
      provenance: {
        ...provenance,
        sourceRef: 'https://example.test/feed',
      },
    }),
    base('voice.policy_reserved', {
      reservationId: 'reservation-1',
      ruleId: 'folks-hour',
      value: 'folks',
      stationHourKey: '2026-09-05T15-0500@America_Winnipeg',
      expiresAtMs: AT + 60_000,
    }),
    base('voice.rewrite', {
      count: 1,
      beforeHash: hash('no-op'),
      afterHash: hash('no-op'),
      outcome: 'passed',
      failedRuleIds: [],
    }),
    ...[
      `https://example.test/feed?api_key=${'a'.repeat(64)}`,
      `https://example.test/feed?x-api-key=${'a'.repeat(64)}`,
      `https://example.test/feed?access_key=${'a'.repeat(64)}`,
      `https://example.test/feed?x-access-key=${'a'.repeat(64)}`,
      `https://example.test/feed?x-goog-signature=${'a'.repeat(64)}`,
      `Fetched from https://example.test/feed?token=${'a'.repeat(32)}`,
      'https://example.test/feed?sv=2026-01-01',
      'https://operator:secret@example.test/feed',
      'Cached at /Users/operator/private/feed.json',
      'Cached at /資料/秘密/feed.json',
      String.raw`Cached at \\server\share\feed.json`,
      'Cached at //server/share/feed.json',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'access_key=abcdefghijklmnopqrstuvwxyz',
      'key=abcdefghijklmnop',
      "'access_key'='quoted-assignment-secret'",
      '{"access_key":"quoted-secret"}',
      '{"nested":{"x-access-key":"quoted-secret"}}',
      'error: {"name":"x-api-key","value":"prefixed-secret"}',
      'provider error: {"API Key":"spaced-key-secret"}',
      'error: {\\"access_key\\":\\"escaped-secret\\"}',
      'credentialValue=abcdefghijklmnopqrstuvwxyz',
      'secretkey=abcdefghijklmnopqrstuvwxyz',
      'refreshtoken=abcdefghijklmnopqrstuvwxyz',
      `https://example.test/feed?secretkey=${'a'.repeat(32)}`,
    ].map((sourceRef) => base('voice.text_policy', {
      ...(eventFor('voice.text_policy') as any).payload,
      provenance: { ...provenance, sourceRef },
    })),
  ];
  for (const event of bad) {
    assert.equal(audit.voiceAuditEventSchema.safeParse(event).success, false);
    await assert.rejects(() => audit.appendLedgerEvent(event));
    await assert.rejects(() => audit.writeSpoolEvent(event));
  }
  assert.equal(existsSync(config.voiceAudit.dir), false);
});

test('health persistence and logging redact private error details', async () => {
  const secret = 'provider error: {"API Key":"spaced-key-secret-value"}';
  const messages: string[] = [];
  audit.setVoiceAuditLogger((message) => messages.push(message));
  await audit.latchVoiceAuditUnhealthy(`audit failure for ${secret}`);
  audit.logVoiceAuditError(`audit failure for ${secret}`);
  audit.logVoiceAuditError(
    'error: {"name":"x-api-key","value":"prefixed-secret-value"}',
  );
  audit.logVoiceAuditError("audit failure for 'access_key'='assignment-secret-value'");
  assert.equal(await audit.recordVoiceAuditRender({
    atMs: AT,
    trigger: 'real',
    status: 'failed',
    targetKey: 'https://voice.test/render?access_key=private-render-key',
  }), false);
  const healthBody = readFileSync(config.voiceAudit.healthFile, 'utf8');
  assert.doesNotMatch(
    healthBody,
    /spaced-key-secret-value|prefixed-secret-value|private-render-key|assignment-secret-value|API Key|x-api-key|access_key/,
  );
  assert.equal(messages.some((message) =>
    /spaced-key-secret-value|prefixed-secret-value|assignment-secret-value|API Key|x-api-key|access_key/
      .test(message)), false);
});

test('replacement spans replay with JavaScript UTF-16 indexes', () => {
  const input = '😀 vibes';
  const output = '😀 music';
  const payload = {
    ...(eventFor('voice.text_policy') as any).payload,
    inputDisplayText: input,
    inputDisplayTextHash: canonicalHash(input),
    displayText: output,
    displayTextHash: canonicalHash(output),
    replacements: [{
      ruleId: 'replace-vibes',
      step: 1,
      inputTextHash: canonicalHash(input),
      sourceStart: 3,
      sourceEnd: 8,
      matchedText: 'vibes',
      matchedTextHash: canonicalHash('vibes'),
      replacement: 'music',
    }],
  };
  assert.equal(audit.voiceAuditEventSchema.safeParse(base('voice.text_policy', payload)).success, true);
  const rewrittenPayload = {
    ...payload,
    displayText: 'A constrained rewrite.',
    displayTextHash: canonicalHash('A constrained rewrite.'),
  };
  assert.equal(
    audit.voiceAuditEventSchema.safeParse(
      base('voice.text_policy', rewrittenPayload),
    ).success,
    true,
  );
  payload.replacements[0].sourceStart = 2;
  assert.equal(audit.voiceAuditEventSchema.safeParse(base('voice.text_policy', payload)).success, false);
  const outOfBounds = structuredClone(payload);
  outOfBounds.replacements[0].sourceStart = 3;
  outOfBounds.replacements[0].sourceEnd = input.length + 20;
  assert.equal(
    audit.voiceAuditEventSchema.safeParse(base('voice.text_policy', outOfBounds)).success,
    false,
  );
  const emptySpan = structuredClone(payload);
  emptySpan.replacements[0].sourceStart = 3;
  emptySpan.replacements[0].sourceEnd = 3;
  emptySpan.replacements[0].matchedText = '';
  emptySpan.replacements[0].matchedTextHash = canonicalHash('');
  assert.equal(
    audit.voiceAuditEventSchema.safeParse(base('voice.text_policy', emptySpan)).success,
    false,
  );
});

test('pre-air audit failure drops automatic voice but warns and allows manual speech', async () => {
  await enableAutomaticAudit();
  rmSync(audit.voiceAuditEventPath(AT), { force: true });
  mkdirSync(audit.voiceAuditEventPath(AT));
  const messages: string[] = [];
  audit.setVoiceAuditLogger((message) => messages.push(message));
  const automatic = await audit.appendPreAir(eventFor('voice.queued'), { automatic: true });
  assert.equal(automatic.ok, false);
  assert.equal((automatic as any).code, 'audit_unavailable');
  assert.doesNotMatch((automatic as any).message, new RegExp(stateRoot));
  const manual = await audit.appendPreAir(eventFor('voice.queued'), { automatic: false });
  assert.equal(manual.ok, true);
  assert.equal(manual.auditPersisted, false);
  assert.match((manual as any).warning, /operator-triggered speech may continue/);
  assert.doesNotMatch((manual as any).warning, new RegExp(stateRoot));
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
  assert.ok(messages.length >= 2);
  assert.equal(messages.some((message) => message.includes(stateRoot)), false);
});

test('a newer health failure invalidates an in-flight automatic pre-air commit', async () => {
  await enableAutomaticAudit();
  const pending = audit.appendPreAir(eventFor('voice.queued'), {
    automatic: true,
  });
  await audit.latchVoiceAuditUnhealthy('concurrent sink failure', AT);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.message, /unavailable|unhealthy/);
});

test('ledger append and recovery never follow a symlink target', async () => {
  await enableAutomaticAudit();
  const victim = join(stateRoot, 'ledger-symlink-victim.txt');
  writeFileSync(victim, 'do not touch');
  rmSync(audit.voiceAuditEventPath(AT), { force: true });
  symlinkSync(victim, audit.voiceAuditEventPath(AT));

  const result = await audit.appendPreAir(eventFor('voice.queued'), {
    automatic: true,
  });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(victim, 'utf8'), 'do not touch');
  await assert.rejects(audit.readLedgerEvents());
  assert.equal(readFileSync(victim, 'utf8'), 'do not touch');
});

test('ledger append rejects a hardlinked mutable target', async () => {
  await enableAutomaticAudit();
  const victim = join(stateRoot, 'ledger-hardlink-victim.txt');
  writeFileSync(victim, 'do not touch');
  rmSync(audit.voiceAuditEventPath(AT), { force: true });
  linkSync(victim, audit.voiceAuditEventPath(AT));

  const result = await audit.appendPreAir(eventFor('voice.queued'), {
    automatic: true,
  });
  assert.equal(result.ok, false);
  assert.equal(readFileSync(victim, 'utf8'), 'do not touch');
  await assert.rejects(audit.readLedgerEvents(), /one-link regular file/);
});

test('ledger checks reject a FIFO without blocking', async () => {
  if (process.platform === 'win32') return;
  await enableAutomaticAudit();
  const fifo = audit.voiceAuditEventPath(AT);
  rmSync(fifo, { force: true });
  execFileSync('mkfifo', [fifo]);

  const result = await audit.appendPreAir(eventFor('voice.queued'), {
    automatic: true,
  });
  assert.equal(result.ok, false);
  await assert.rejects(audit.readLedgerEvents(), /one-link regular file/);
});

test('health probe checks the actual current ledger append path', async () => {
  mkdirSync(config.voiceAudit.dir, { recursive: true });
  mkdirSync(audit.voiceAuditEventPath(AT));
  const probe = await audit.runVoiceAuditHealthProbe(AT);
  assert.equal(probe.ledger.ok, false);
  assert.equal(probe.spool.ok, true);
  assert.equal(probe.healthy, false);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
});

test('a stale successful health probe cannot clear a newer failure', async () => {
  await audit.latchVoiceAuditUnhealthy('older failure', AT);
  const staleProbe = audit.runVoiceAuditHealthProbe(AT + 1_000, {
    recoveryComplete: true,
  });
  await audit.latchVoiceAuditUnhealthy('newer failure', AT + 500);
  await staleProbe;
  const health = await audit.readVoiceAuditHealth();
  assert.equal(health.auditUnhealthy, true);
  assert.equal(health.reason, 'newer failure');
});

test('live Doctor summary overlays the latch only while QA is enabled', async () => {
  const summary = {
    t: new Date(AT).toISOString(),
    counts: { ok: 3, warn: 0, fail: 0, skip: 0 },
    overall: 'healthy' as const,
  };
  assert.deepEqual(await audit.overlayVoiceAuditSummary(summary, false), summary);
  assert.equal(existsSync(config.voiceAudit.dir), false);
  await audit.latchVoiceAuditUnhealthy('test failure', AT);
  const overlaid = await audit.overlayVoiceAuditSummary(summary, true);
  assert.equal(overlaid.overall, 'critical');
  assert.equal(overlaid.counts?.fail, 1);
});

test('Doctor stays side-effect free while disabled and observes the enabled latch', async () => {
  const disabled = await checkTts({ tts: { broadcastQa: { enabled: false } } });
  assert.equal(
    disabled.some((finding) => finding.label.startsWith('broadcast QA')
      || finding.label.startsWith('voice audit')),
    false,
  );
  assert.equal(existsSync(config.voiceAudit.dir), false);

  await audit.latchVoiceAuditUnhealthy('doctor observation', AT);
  mkdirSync(audit.voiceAuditEventPath(Date.now()), { recursive: true });
  const enabled = await checkTts({ tts: { broadcastQa: { enabled: true } } });
  assert.equal(enabled.some((finding) => finding.label === 'broadcast QA ffmpeg'), true);
  assert.equal(enabled.some((finding) => finding.label === 'broadcast QA ffprobe'), true);
  assert.equal(
    enabled.some((finding) =>
      finding.label === 'voice audit health' && finding.status === 'fail'),
    true,
  );
  const ledgerFinding = enabled.find((finding) => finding.label === 'voice audit ledger');
  assert.equal(ledgerFinding?.status, 'fail');
  assert.equal(ledgerFinding?.detail?.includes(stateRoot), false);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
});

test('post-air failure falls back to spool and drains in timestamp order', async () => {
  mkdirSync(config.voiceAudit.dir, { recursive: true });
  mkdirSync(audit.voiceAuditEventPath(AT));
  const later = eventFor('voice.ended');
  later.atMs = AT + 10;
  const earlier = eventFor('voice.started');
  earlier.atMs = AT + 5;
  assert.deepEqual(await audit.appendPostAir(later), { ok: true, sink: 'spool' });
  assert.deepEqual(await audit.appendPostAir(earlier), { ok: true, sink: 'spool' });
  assert.equal(readdirSync(config.voiceAudit.spoolDir).length, 2);

  rmSync(audit.voiceAuditEventPath(AT), { recursive: true, force: true });
  const drains = await Promise.all([
    audit.drainVoiceAuditSpool(),
    audit.drainVoiceAuditSpool(),
  ]);
  assert.equal(drains.reduce((sum, result) => sum + result.drained, 0), 2);
  assert.equal(drains.every((result) => result.remaining === 0), true);
  const events = await audit.readLedgerEvents();
  assert.deepEqual(events.map((event) => event.type), ['voice.started', 'voice.ended']);
});

test('an undrainable spool record prevents latch recovery', async () => {
  await audit.latchVoiceAuditUnhealthy('prior sink failure', AT);
  mkdirSync(config.voiceAudit.spoolDir, { recursive: true });
  writeFileSync(
    join(config.voiceAudit.spoolDir, `000${AT}-${'a'.repeat(32)}.json`),
    '{not-json',
  );
  const startup = await audit.ensureVoiceAuditStarted({ enabled: true });
  assert.equal(startup.ok, false);
  assert.match(startup.message, /spool drain failed/);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
});

test('startup quarantines a torn final ledger record before recovery', async () => {
  await audit.appendLedgerEvent(eventFor('voice.started'));
  const ledgerPath = audit.voiceAuditEventPath(AT);
  const tornRecord = Buffer.from('{"displayText":"é');
  const partialRecord = tornRecord.subarray(0, tornRecord.length - 1);
  appendFileSync(ledgerPath, partialRecord);

  const failed = await audit.ensureVoiceAuditStarted({ enabled: true });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /quarantined torn final audit record/);
  assert.equal(readFileSync(ledgerPath, 'utf8').endsWith('\n'), true);
  const fragment = readdirSync(config.voiceAudit.dir)
    .find((name) => name.endsWith('.fragment'));
  assert.ok(fragment);
  assert.deepEqual(readFileSync(join(config.voiceAudit.dir, fragment)), partialRecord);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);

  const recovered = await audit.ensureVoiceAuditStarted({ enabled: true });
  assert.equal(recovered.ok, true);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, false);
});

test('latch recovery rechecks ledger integrity after startup', async () => {
  await audit.appendLedgerEvent(eventFor('voice.started'));
  assert.equal((await audit.ensureVoiceAuditStarted({ enabled: true })).ok, true);
  appendFileSync(audit.voiceAuditEventPath(AT), '{not-json}\n');
  await audit.latchVoiceAuditUnhealthy('append rollback was uncertain', AT);

  const recovery = await audit.ensureVoiceAuditStarted({ enabled: true });
  assert.equal(recovery.ok, false);
  assert.match(recovery.message, /invalid voice audit JSON/);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
});

test('disable and re-enable invalidates the prior ledger integrity check', async () => {
  const started = eventFor('voice.started');
  await audit.appendLedgerEvent(started);
  assert.equal((await audit.ensureVoiceAuditStarted({ enabled: true })).ok, true);

  const ended = eventFor('voice.ended');
  ended.eventId = started.eventId;
  appendFileSync(audit.voiceAuditEventPath(AT), `${JSON.stringify(ended)}\n`);
  await audit.suspendVoiceAuditLifecycle();

  const recoveryPending = audit.ensureVoiceAuditStarted({ enabled: true });
  const duringRecovery = await audit.appendPreAir(eventFor('voice.queued'), {
    automatic: true,
  });
  assert.equal(duringRecovery.ok, false);
  const recovery = await recoveryPending;
  assert.equal(recovery.ok, false);
  assert.match(recovery.message, /eventId collision/);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
});

test('rapid enable-disable-enable reruns recovery without waiting for a tick', async () => {
  const firstEnable = audit.ensureVoiceAuditStarted({ enabled: true });
  await audit.suspendVoiceAuditLifecycle();
  const secondEnable = audit.ensureVoiceAuditStarted({ enabled: true });
  await firstEnable;
  assert.equal((await secondEnable).ok, true);
  assert.deepEqual(
    await audit.appendPreAir(eventFor('voice.queued'), { automatic: true }),
    { ok: true, auditPersisted: true },
  );
});

test('a queued startup cannot run after a later final disable', async () => {
  const firstEnable = audit.ensureVoiceAuditStarted({ enabled: true });
  await audit.suspendVoiceAuditLifecycle();
  const staleEnable = audit.ensureVoiceAuditStarted({ enabled: true });
  await audit.suspendVoiceAuditLifecycle();
  await firstEnable;
  assert.deepEqual(
    await staleEnable,
    { ok: true, started: false, drained: 0 },
  );
  assert.equal(existsSync(config.voiceAudit.dir), false);
});

test('a healthy minute tick does not close automatic admission', async () => {
  await enableAutomaticAudit();
  const minute = audit.runVoiceAuditMinute({ enabled: true });
  const duringProbe = await audit.appendPreAir(eventFor('voice.queued'), {
    automatic: true,
  });
  assert.deepEqual(duringProbe, { ok: true, auditPersisted: true });
  assert.equal((await minute).ok, true);
  assert.notEqual(
    (await audit.readVoiceAuditHealth()).lastHealthyProbeAtMs,
    null,
  );
});

test('live ledger writes no-op identical retries and reject event ID collisions', async () => {
  const started = eventFor('voice.started');
  const ended = eventFor('voice.ended');
  ended.eventId = started.eventId;
  await audit.appendLedgerEvent(started);
  await audit.appendLedgerEvent(started);
  await assert.rejects(
    audit.appendLedgerEvent(ended),
    /eventId collision/,
  );
  assert.equal((await audit.readLedgerEvents()).length, 1);
});

test('ledger append quarantines a torn tail before adding another event', async () => {
  const started = eventFor('voice.started');
  await audit.appendLedgerEvent(started);
  appendFileSync(audit.voiceAuditEventPath(started.atMs), '{"partial":');
  const ended = eventFor('voice.ended');
  await assert.rejects(
    audit.appendLedgerEvent(ended),
    /quarantined torn final audit record/,
  );
  assert.equal(
    readFileSync(audit.voiceAuditEventPath(started.atMs), 'utf8').endsWith('\n'),
    true,
  );
  await audit.appendLedgerEvent(ended);
  assert.equal((await audit.readLedgerEvents()).length, 2);
});

test('spool replay is idempotent after ledger success and detects event-id collisions', async () => {
  const event = eventFor('voice.started');
  mkdirSync(config.voiceAudit.spoolDir, { recursive: true });
  writeFileSync(
    join(config.voiceAudit.spoolDir, `${String(event.atMs).padStart(16, '0')}-${'b'.repeat(32)}.json`),
    JSON.stringify(event),
  );
  await assert.rejects(audit.readSpoolEvents(), /filename does not match/);
  rmSync(config.voiceAudit.spoolDir, { recursive: true, force: true });

  await audit.writeSpoolEvent(event);
  await audit.writeSpoolEvent(event);
  assert.equal(readdirSync(config.voiceAudit.spoolDir).length, 1);
  const spoolConflict = eventFor('voice.ended');
  spoolConflict.eventId = event.eventId;
  spoolConflict.atMs = event.atMs;
  await assert.rejects(
    audit.writeSpoolEvent(spoolConflict),
    /spool eventId collision/,
  );
  await audit.appendLedgerEvent(event);
  assert.deepEqual(await audit.drainVoiceAuditSpool(), { drained: 1, remaining: 0 });
  assert.equal((await audit.readLedgerEvents()).length, 1);

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  audit.resetVoiceAuditSpoolForTests();
  await audit.writeSpoolEvent(event);
  const conflict = eventFor('voice.ended');
  conflict.eventId = event.eventId;
  conflict.atMs = event.atMs;
  appendFileSync(
    audit.voiceAuditEventPath(conflict.atMs),
    `${JSON.stringify(conflict)}\n`,
  );
  await assert.rejects(
    audit.drainVoiceAuditSpool(),
    /eventId collision/,
  );
  assert.equal(readdirSync(config.voiceAudit.spoolDir).length, 1);
});

test('spool read repairs an interrupted exclusive hard-link publication', async () => {
  const event = eventFor('voice.started');
  await audit.writeSpoolEvent(event);
  const file = readdirSync(config.voiceAudit.spoolDir)[0];
  const path = join(config.voiceAudit.spoolDir, file);
  const temporary = `${path}.999.${'a'.repeat(12)}.tmp`;
  linkSync(path, temporary);
  assert.equal(statSync(path).nlink, 2);
  assert.equal((await audit.readSpoolEvents()).length, 1);
  assert.equal(existsSync(temporary), false);
  assert.equal(statSync(path).nlink, 1);
});

test('automatic pre-air admission rejects a conflicting spooled event ID', async () => {
  await enableAutomaticAudit();
  const spooled = eventFor('voice.started');
  await audit.writeSpoolEvent(spooled);
  const conflict = eventFor('voice.ended');
  conflict.eventId = spooled.eventId;
  conflict.atMs = spooled.atMs;
  const result = await audit.appendPreAir(conflict, { automatic: true });
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.message, /eventId collision/);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
  assert.deepEqual(await audit.readLedgerEvents(), []);
});

test('losing both post-air sinks persists or retains audit_unhealthy and blocks automatic voice', async () => {
  mkdirSync(config.voiceAudit.dir, { recursive: true });
  mkdirSync(audit.voiceAuditEventPath(AT));
  writeFileSync(config.voiceAudit.spoolDir, 'not a directory');
  const lost = await audit.appendPostAir(eventFor('voice.ended'));
  assert.equal(lost.ok, false);
  const health = await audit.readVoiceAuditHealth();
  assert.equal(health.auditUnhealthy, true);
  assert.match(health.reason ?? '', /lost durable sinks/);
  assert.equal(health.reason?.includes(stateRoot), false);
  audit.resetVoiceAuditHealthForTests();
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
  const blocked = await audit.appendPreAir(eventFor('voice.queued'), { automatic: true });
  assert.equal(blocked.ok, false);
  assert.match((blocked as any).message, /unhealthy/);

  const failedProbe = await audit.runVoiceAuditHealthProbe();
  assert.equal(failedProbe.healthy, false);
  rmSync(config.voiceAudit.spoolDir, { force: true });
  rmSync(audit.voiceAuditEventPath(AT), { recursive: true, force: true });
  const readOnlyProbe = await audit.runVoiceAuditHealthProbe();
  assert.equal(readOnlyProbe.ledger.ok, true);
  assert.equal(readOnlyProbe.spool.ok, true);
  assert.equal(readOnlyProbe.healthy, false);
  const healthyProbe = await audit.ensureVoiceAuditStarted({ enabled: true });
  assert.equal(healthyProbe.ok, true);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, false);
});

test('station-hour keys distinguish fall-back hours and skip spring-forward hour', () => {
  assert.equal(
    stationHourKey(new Date('2026-11-01T06:30:00.000Z'), 'America/Winnipeg'),
    '2026-11-01T01-0500@America_Winnipeg',
  );
  assert.equal(
    stationHourKey(new Date('2026-11-01T07:30:00.000Z'), 'America/Winnipeg'),
    '2026-11-01T01-0600@America_Winnipeg',
  );
  assert.equal(
    stationHourKey(new Date('2026-03-08T07:30:00.000Z'), 'America/Winnipeg'),
    '2026-03-08T01-0600@America_Winnipeg',
  );
  assert.equal(
    stationHourKey(new Date('2026-03-08T08:30:00.000Z'), 'America/Winnipeg'),
    '2026-03-08T03-0500@America_Winnipeg',
  );
});

test('rolling policy counts durable starts and active reservations', () => {
  const rule = { id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 };
  const empty = audit.recheckRollingRules([], [], {
    displayText: 'Folks, one thought.',
    rules: [rule],
    stationHourKey: HOUR,
  }, AT);
  assert.equal(empty.ok, true);
  const full = audit.recheckRollingRules([{
    auditId: 'prior',
    ruleId: rule.id,
    value: rule.value,
    stationHourKey: HOUR,
  }], [], {
    displayText: 'folks, another thought.',
    rules: [rule],
    stationHourKey: HOUR,
  }, AT);
  assert.deepEqual(full, { ok: false, occurrences: [], failedRuleIds: ['folks-hour'] });
});

test('rolling history ignores starts that predate their reservation evidence', async () => {
  await audit.appendLedgerEvent(eventFor('voice.policy_reserved'));
  const started = eventFor('voice.started');
  started.atMs = AT - 10_000;
  if (started.type === 'voice.started') {
    started.payload.clipStartedAt = AT - 10_000;
    started.payload.audibleStartedAt = AT - 9_920;
  }
  await audit.appendLedgerEvent(started);
  assert.deepEqual(await audit.readStartedRollingHistory(), []);
});

test('corrupt rolling state fails automatic reservation closed', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  writeFileSync(config.voiceAudit.rollingReservationsFile, '{not-json');
  const result = await audit.reserveRollingRules({
    auditId: 'audit-a',
    voiceId: 'voice-a',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: Date.now() + 1_000,
    expiresAtMs: Date.now() + 60_000,
    automatic: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'audit_unavailable');
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
});

test('manual speech survives rolling audit storage failure with a warning', async () => {
  setStationTimezone('UTC');
  mkdirSync(config.voiceAudit.dir, { recursive: true });
  writeFileSync(config.voiceAudit.rollingReservationsFile, '{not-json');
  const result = await audit.reserveRollingRules({
    auditId: 'audit-manual',
    voiceId: 'voice-manual',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: Date.now() + 1_000,
    expiresAtMs: Date.now() + 60_000,
    automatic: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.auditPersisted : true, false);
  assert.match(result.ok ? result.warning ?? '' : '', /may continue unaudited/);
});

test('manual rolling success preserves the ledger failure warning', async () => {
  setStationTimezone('UTC');
  const now = Date.now();
  const existingEvent = eventFor('voice.started');
  existingEvent.atMs = now;
  await audit.appendLedgerEvent(existingEvent);
  chmodSync(audit.voiceAuditEventPath(now), 0o444);
  const result = await audit.reserveRollingRules({
    auditId: 'audit-manual-ledger',
    voiceId: 'voice-manual-ledger',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.auditPersisted : true, false);
  assert.match(result.ok ? result.warning ?? '' : '', /voice audit write failed/);
  assert.equal((await audit.readRollingReservations()).length, 1);
});

test('rolling state rejects private identifiers before publication', async () => {
  setStationTimezone('UTC');
  const secret = 'https://example.test/feed?access_key=do-not-persist';
  const now = Date.now();
  const result = await audit.reserveRollingRules({
    auditId: 'audit-private-state',
    voiceId: secret,
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok ? result.auditPersisted : true, false);
  assert.equal(existsSync(config.voiceAudit.rollingReservationsFile), false);
  assert.equal(
    existsSync(config.voiceAudit.healthFile)
      ? readFileSync(config.voiceAudit.healthFile, 'utf8').includes(secret)
      : false,
    false,
  );
});

test('concurrent rolling reservations cannot both consume the last allowance', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const request = {
    voiceId: 'voice-1',
    displayText: 'Folks, one thought.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  };
  const results = await Promise.all([
    audit.reserveRollingRules({ ...request, auditId: 'audit-a' }),
    audit.reserveRollingRules({ ...request, auditId: 'audit-b' }),
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok).length, 1);
  const rows = await audit.readRollingReservations();
  assert.equal(rows.length, 1);
  const started = eventFor('voice.started');
  started.auditId = rows[0].auditId;
  started.stationHourKey = rows[0].stationHourKey;
  started.atMs = now + 2_000;
  if (started.type === 'voice.started') {
    started.payload.clipStartedAt = now + 2_000;
    started.payload.audibleStartedAt = now + 2_080;
  }
  await audit.writeSpoolEvent(started);
  assert.deepEqual(
    (await audit.readStartedRollingHistory()).map((row) => row.reservationId),
    [rows[0].reservationId],
  );
});

test('rolling reservation retries reuse IDs and repair partial audit evidence', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const request = {
    auditId: 'audit-retry',
    traceId: 'trace-retry',
    candidateId: 'candidate-retry',
    voiceId: 'voice-retry',
    displayText: 'Folks, folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 2 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  };
  const first = await audit.reserveRollingRules(request);
  assert.equal(first.ok, true);
  const firstIds = first.ok
    ? first.reservations.map((reservation) => reservation.reservationId)
    : [];
  assert.equal(firstIds.length, 2);
  const ledgerPath = audit.voiceAuditEventPath(now);
  const partialLedger = readFileSync(ledgerPath, 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => {
      const event = JSON.parse(line);
      return event.type !== 'voice.policy_reserved'
        || event.payload.reservationId !== firstIds[1];
    })
    .join('\n') + '\n';
  writeFileSync(ledgerPath, partialLedger);

  const retry = await audit.reserveRollingRules(request);
  assert.equal(retry.ok, true);
  assert.deepEqual(
    retry.ok ? retry.reservations : [],
    first.ok ? first.reservations : [],
  );
  assert.equal((await audit.readRollingReservations()).length, 2);
  assert.equal(
    (await audit.readLedgerEvents())
      .filter((event) => event.type === 'voice.policy_reserved').length,
    2,
  );
});

test('startup repairs active rolling evidence before reopening automatic voice', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const reserved = await audit.reserveRollingRules({
    auditId: 'audit-startup-repair',
    voiceId: 'voice-startup-repair',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  });
  assert.equal(reserved.ok, true);
  const row = reserved.ok ? reserved.reservations[0] : null;
  assert.ok(row);
  const ledgerPath = audit.voiceAuditEventPath(row.createdAtMs);
  writeFileSync(
    ledgerPath,
    readFileSync(ledgerPath, 'utf8')
      .split('\n')
      .filter((line) => !line || JSON.parse(line).type !== 'voice.policy_reserved')
      .join('\n'),
  );
  await audit.suspendVoiceAuditLifecycle();
  assert.equal((await audit.ensureVoiceAuditStarted({ enabled: true })).ok, true);
  assert.equal((await audit.readLedgerEvents()).some((event) =>
    event.type === 'voice.policy_reserved'
    && event.payload.reservationId === row.reservationId), true);

  const started = eventFor('voice.started');
  started.auditId = row.auditId;
  started.voiceId = row.voiceId;
  started.stationHourKey = row.stationHourKey;
  started.atMs = now + 2_000;
  await audit.appendLedgerEvent(started);
  assert.equal(await audit.recoverExpiredRollingReservations({
    nowMs: now + 3_000,
    referencesComplete: true,
  }), 1);
  assert.deepEqual(await audit.readRollingReservations(), []);
  assert.equal((await audit.readLedgerEvents()).some((event) =>
    event.type === 'voice.policy_released'
    && event.payload.reservationId === row.reservationId
    && event.payload.reason === 'started'), true);
});

test('duplicate rolling reservation evidence fails closed', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const reserved = await audit.reserveRollingRules({
    auditId: 'audit-duplicate',
    voiceId: 'voice-duplicate',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  });
  assert.equal(reserved.ok, true);
  const original = (await audit.readLedgerEvents())
    .find((event) => event.type === 'voice.policy_reserved');
  assert.ok(original);
  await audit.appendLedgerEvent({
    ...original,
    eventId: `${original.eventId}-duplicate`,
  });
  await assert.rejects(
    audit.readStartedRollingHistory(),
    /duplicate rolling reservation evidence/,
  );
});

test('partial multi-release recovery converges per reservation ID', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const reserved = await audit.reserveRollingRules({
    auditId: 'audit-release',
    voiceId: 'voice-release',
    displayText: 'Folks, folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 2 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  });
  assert.equal(reserved.ok, true);
  const rows = reserved.ok ? reserved.reservations : [];
  const started = eventFor('voice.started');
  started.auditId = rows[0].auditId;
  started.voiceId = rows[0].voiceId;
  started.stationHourKey = rows[0].stationHourKey;
  started.atMs = now + 1_500;
  await audit.appendLedgerEvent(started);
  const dropped = eventFor('voice.dropped');
  dropped.auditId = rows[0].auditId;
  dropped.voiceId = rows[0].voiceId;
  dropped.stationHourKey = rows[0].stationHourKey;
  dropped.atMs = now + 1_600;
  await audit.appendLedgerEvent(dropped);
  await audit.appendLedgerEvent(base('voice.policy_released', {
    reservationId: rows[0].reservationId,
    reason: 'started',
  }, {
    auditId: rows[0].auditId,
    voiceId: rows[0].voiceId,
    stationHourKey: rows[0].stationHourKey,
    atMs: now + 1_700,
  }));
  assert.equal(await audit.releaseRollingRules({
    auditId: rows[0].auditId,
    voiceId: rows[0].voiceId,
    stationHourKey: rows[0].stationHourKey,
    reservationIds: rows.map((row) => row.reservationId),
    reason: 'dropped',
    atMs: now + 2_000,
  }), 2);
  assert.deepEqual(await audit.readRollingReservations(), []);
  const reasons = (await audit.readLedgerEvents())
    .filter((event) => event.type === 'voice.policy_released')
    .map((event) => event.payload.reason)
    .sort();
  assert.deepEqual(reasons, ['dropped', 'started']);
});

test('rolling release requires the terminal event full ownership group', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const reserved = await audit.reserveRollingRules({
    auditId: 'audit-group',
    voiceId: 'voice-group',
    displayText: 'Folks, folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 2 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  });
  assert.equal(reserved.ok, true);
  const rows = reserved.ok ? reserved.reservations : [];
  const dropped = eventFor('voice.dropped');
  dropped.auditId = rows[0].auditId;
  dropped.voiceId = rows[0].voiceId;
  dropped.stationHourKey = rows[0].stationHourKey;
  dropped.atMs = now + 2_000;
  await audit.appendLedgerEvent(dropped);
  const owner = {
    auditId: rows[0].auditId,
    voiceId: rows[0].voiceId,
    stationHourKey: rows[0].stationHourKey,
  };
  assert.equal(await audit.releaseRollingRules({
    ...owner,
    reservationIds: [rows[0].reservationId],
    reason: 'dropped',
    atMs: now + 2_000,
  }), 0);
  assert.equal((await audit.readRollingReservations()).length, 2);
  assert.equal(await audit.releaseRollingRules({
    ...owner,
    reservationIds: rows.map((row) => row.reservationId),
    reason: 'dropped',
    atMs: now + 2_000,
  }), 2);
  assert.deepEqual(await audit.readRollingReservations(), []);
});

test('rolling release rejects an inexact or unowned reservation set', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const reserved = await audit.reserveRollingRules({
    auditId: 'audit-owner',
    voiceId: 'voice-owner',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  });
  assert.equal(reserved.ok, true);
  const row = reserved.ok ? reserved.reservations[0] : null;
  assert.ok(row);
  const dropped = eventFor('voice.dropped');
  dropped.auditId = row.auditId;
  dropped.voiceId = row.voiceId;
  dropped.stationHourKey = row.stationHourKey;
  dropped.atMs = now + 2_000;
  await audit.appendLedgerEvent(dropped);
  assert.equal(await audit.releaseRollingRules({
    auditId: row.auditId,
    voiceId: row.voiceId,
    stationHourKey: row.stationHourKey,
    reservationIds: [row.reservationId, 'unknown-reservation'],
    reason: 'dropped',
    atMs: now + 2_000,
  }), 0);
  assert.equal((await audit.readRollingReservations()).length, 1);
  assert.equal((await audit.readVoiceAuditHealth()).auditUnhealthy, true);
});

test('durable voice.started is authoritative over release labels', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const request = {
    voiceId: 'voice-1',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  };
  const notStarted = await audit.reserveRollingRules({ ...request, auditId: 'audit-a' });
  assert.equal(notStarted.ok, true);
  const notStartedRow = notStarted.ok ? notStarted.reservations[0] : null;
  assert.ok(notStartedRow);
  const dropped = eventFor('voice.dropped');
  dropped.auditId = notStartedRow.auditId;
  dropped.voiceId = notStartedRow.voiceId;
  dropped.stationHourKey = notStartedRow.stationHourKey;
  dropped.atMs = now + 2_000;
  await audit.appendLedgerEvent(dropped);
  await audit.releaseRollingRules({
    auditId: notStartedRow.auditId,
    voiceId: notStartedRow.voiceId,
    stationHourKey: notStartedRow.stationHourKey,
    reservationIds: [notStartedRow.reservationId],
    reason: 'dropped',
    atMs: now + 2_000,
  });
  assert.deepEqual(await audit.readStartedRollingHistory(), []);

  const didStart = await audit.reserveRollingRules({ ...request, auditId: 'audit-b' });
  assert.equal(didStart.ok, true);
  const row = didStart.ok ? didStart.reservations[0] : null;
  assert.ok(row);
  const started = eventFor('voice.started');
  started.auditId = row.auditId;
  started.stationHourKey = row.stationHourKey;
  started.atMs = now + 3_000;
  if (started.type === 'voice.started') {
    started.payload.clipStartedAt = now + 3_000;
    started.payload.audibleStartedAt = now + 3_080;
  }
  await audit.appendLedgerEvent(started);
  await audit.releaseRollingRules({
    auditId: row.auditId,
    voiceId: row.voiceId,
    stationHourKey: row.stationHourKey,
    reservationIds: [row.reservationId],
    reason: 'started',
    atMs: now + 3_000,
  });
  assert.deepEqual(
    (await audit.readStartedRollingHistory()).map((entry) => entry.reservationId),
    [row.reservationId],
  );
});

test('a started reservation is not double-counted before its release arrives', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const now = Date.now();
  const rules = [{
    id: 'folks-hour',
    type: 'station-hour-limit' as const,
    value: 'folks',
    max: 2,
  }];
  const first = await audit.reserveRollingRules({
    auditId: 'audit-first',
    voiceId: 'voice-1',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  });
  assert.equal(first.ok, true);
  const started = eventFor('voice.started');
  started.auditId = 'audit-first';
  started.stationHourKey = first.stationHourKey;
  await audit.appendLedgerEvent(started);

  const second = await audit.reserveRollingRules({
    auditId: 'audit-second',
    voiceId: 'voice-2',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: now + 2_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  });
  assert.equal(second.ok, true);
});

test('cross-hour policy denial retains the still-live prior reservation IDs', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const rules = [{
    id: 'folks-hour',
    type: 'station-hour-limit' as const,
    value: 'folks',
    max: 1,
  }];
  const original = await audit.reserveRollingRules({
    auditId: 'audit-moving-denied',
    voiceId: 'voice-moving-denied',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T12:59:30.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
  });
  assert.equal(original.ok, true);
  const oldIds = original.ok
    ? original.reservations.map((reservation) => reservation.reservationId)
    : [];
  assert.equal((await audit.reserveRollingRules({
    auditId: 'audit-hour-blocker',
    voiceId: 'voice-hour-blocker',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
  })).ok, true);
  const denied = await audit.reserveRollingRules({
    auditId: 'audit-moving-denied',
    voiceId: 'voice-moving-denied',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:02.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
    replaceReservationIds: oldIds,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.ok ? '' : denied.code, 'text_policy_failed');
  assert.deepEqual(
    denied.ok
      ? []
      : denied.retainedReservations.map((reservation) => reservation.reservationId),
    oldIds,
  );
  const activeIds = new Set(
    (await audit.readRollingReservations()).map((reservation) => reservation.reservationId),
  );
  assert.equal(oldIds.every((reservationId) => activeIds.has(reservationId)), true);
});

test('cross-hour re-reservation is one durable replacement or a drop', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const rules = [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }];
  const first = await audit.reserveRollingRules({
    auditId: 'audit-a',
    voiceId: 'voice-1',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T12:59:30.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
  });
  assert.equal(first.ok, true);
  const oldIds = first.ok ? first.reservations.map((row) => row.reservationId) : [];
  const omittedReplacement = await audit.reserveRollingRules({
    auditId: 'audit-a',
    voiceId: 'voice-1',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
  });
  assert.equal(omittedReplacement.ok, false);
  assert.equal(omittedReplacement.code, 'audit_unavailable');
  assert.deepEqual(
    omittedReplacement.ok
      ? []
      : omittedReplacement.retainedReservations.map((row) => row.reservationId),
    oldIds,
  );
  assert.equal((await audit.readRollingReservations())[0].reservationId, oldIds[0]);
  const hijacked = await audit.reserveRollingRules({
    auditId: 'audit-b',
    voiceId: 'voice-1',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
    replaceReservationIds: oldIds,
  });
  assert.equal(hijacked.ok, false);
  assert.equal(hijacked.code, 'audit_unavailable');
  const sameHour = await audit.reserveRollingRules({
    auditId: 'audit-a',
    voiceId: 'voice-1',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T12:59:45.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
    replaceReservationIds: oldIds,
  });
  assert.equal(sameHour.ok, false);
  assert.equal((await audit.readRollingReservations())[0].reservationId, oldIds[0]);
  const moved = await audit.reserveRollingRules({
    auditId: 'audit-a',
    voiceId: 'voice-1',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
    replaceReservationIds: oldIds,
  });
  assert.equal(moved.ok, true);
  const rows = await audit.readRollingReservations();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stationHourKey, '2030-01-01T13+0000@UTC');
  assert.equal(oldIds.includes(rows[0].reservationId), false);
  const rollingLedger = join(
    config.voiceAudit.dir,
    readdirSync(config.voiceAudit.dir).find((name) => /^events-.*\.jsonl$/.test(name))!,
  );
  const withoutOldRelease = readFileSync(rollingLedger, 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => {
      const event = JSON.parse(line);
      return event.type !== 'voice.policy_released'
        || !oldIds.includes(event.payload.reservationId);
    })
    .join('\n') + '\n';
  writeFileSync(rollingLedger, withoutOldRelease);

  const movedRetry = await audit.reserveRollingRules({
    auditId: 'audit-a',
    voiceId: 'voice-1',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
    replaceReservationIds: oldIds,
  });
  assert.equal(movedRetry.ok, true);
  assert.deepEqual(
    movedRetry.ok ? movedRetry.reservations.map((row) => row.reservationId) : [],
    rows.map((row) => row.reservationId),
  );
  assert.equal(
    (await audit.readLedgerAndSpoolEvents()).some((event) =>
      event.type === 'voice.policy_released'
      && oldIds.includes(event.payload.reservationId)
      && event.payload.reason === 'recovered'),
    true,
  );
  const started = eventFor('voice.started');
  const startedAtMs = Date.parse('2030-01-01T13:00:05.000Z');
  started.auditId = 'audit-a';
  started.atMs = startedAtMs;
  started.stationHourKey = rows[0].stationHourKey;
  if (started.type === 'voice.started') {
    started.payload.clipStartedAt = startedAtMs;
    started.payload.audibleStartedAt = startedAtMs;
  }
  await audit.appendLedgerEvent(started);
  await audit.releaseRollingRules({
    auditId: rows[0].auditId,
    voiceId: rows[0].voiceId,
    stationHourKey: rows[0].stationHourKey,
    reservationIds: [rows[0].reservationId],
    reason: 'started',
    atMs: startedAtMs,
  });
  const history = await audit.readStartedRollingHistory();
  assert.deepEqual(
    history.map((row) => row.reservationId),
    [rows[0].reservationId],
  );
});

test('cross-hour release to zero reservations is idempotent', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const rules = [{
    id: 'folks-hour',
    type: 'station-hour-limit' as const,
    value: 'folks',
    max: 1,
  }];
  const original = await audit.reserveRollingRules({
    auditId: 'audit-zero',
    voiceId: 'voice-zero',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T12:59:30.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
  });
  assert.equal(original.ok, true);
  const oldIds = original.ok
    ? original.reservations.map((reservation) => reservation.reservationId)
    : [];
  const request = {
    auditId: 'audit-zero',
    voiceId: 'voice-zero',
    displayText: 'No limited phrase.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
    replaceReservationIds: oldIds,
  };
  const moved = await audit.reserveRollingRules(request);
  const retry = await audit.reserveRollingRules(request);
  assert.equal(moved.ok, true);
  assert.equal(retry.ok, true);
  assert.deepEqual(moved.ok ? moved.reservations : null, []);
  assert.deepEqual(retry.ok ? retry.reservations : null, []);
  assert.deepEqual(await audit.readRollingReservations(), []);
});

test('manual zero-reservation cross-hour retry survives unavailable release sinks', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const rules = [{
    id: 'folks-hour',
    type: 'station-hour-limit' as const,
    value: 'folks',
    max: 1,
  }];
  const original = await audit.reserveRollingRules({
    auditId: 'audit-zero-manual',
    voiceId: 'voice-zero-manual',
    displayText: 'Folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T12:59:30.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
  });
  assert.equal(original.ok, true);
  const oldIds = original.ok
    ? original.reservations.map((reservation) => reservation.reservationId)
    : [];
  const request = {
    auditId: 'audit-zero-manual',
    voiceId: 'voice-zero-manual',
    displayText: 'No limited phrase.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    replaceReservationIds: oldIds,
  };
  assert.equal((await audit.reserveRollingRules({
    ...request,
    automatic: true,
  })).ok, true);

  const ledgerPath = audit.voiceAuditEventPath(Date.now());
  writeFileSync(
    ledgerPath,
    readFileSync(ledgerPath, 'utf8')
      .trimEnd()
      .split('\n')
      .filter((line) => {
        const event = JSON.parse(line);
        return event.type !== 'voice.policy_released'
          || !oldIds.includes(event.payload.reservationId);
      })
      .join('\n') + '\n',
  );
  audit.resetVoiceAuditLedgerForTests();
  mkdirSync(config.voiceAudit.spoolDir, { recursive: true });
  chmodSync(ledgerPath, 0o444);
  chmodSync(config.voiceAudit.spoolDir, 0o555);
  try {
    const retry = await audit.reserveRollingRules({
      ...request,
      automatic: false,
    });
    assert.equal(retry.ok, true);
    assert.deepEqual(retry.ok ? retry.reservations : null, []);
    assert.equal(retry.ok ? retry.auditPersisted : true, false);
    assert.match(
      retry.ok ? retry.warning ?? '' : '',
      /release evidence is unavailable.*may continue unaudited/,
    );
  } finally {
    chmodSync(ledgerPath, 0o600);
    chmodSync(config.voiceAudit.spoolDir, 0o700);
  }
});

test('cross-hour replacement repairs every prior reservation event first', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const rules = [{
    id: 'folks-hour',
    type: 'station-hour-limit' as const,
    value: 'folks',
    max: 2,
  }];
  const original = await audit.reserveRollingRules({
    auditId: 'audit-repair-cross',
    voiceId: 'voice-repair-cross',
    displayText: 'Folks, folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T12:59:30.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
  });
  assert.equal(original.ok, true);
  const oldIds = original.ok
    ? original.reservations.map((reservation) => reservation.reservationId)
    : [];
  const ledgerPath = audit.voiceAuditEventPath(Date.now());
  const incomplete = readFileSync(ledgerPath, 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => {
      const event = JSON.parse(line);
      return event.type !== 'voice.policy_reserved'
        || event.payload.reservationId !== oldIds[1];
    })
    .join('\n') + '\n';
  writeFileSync(ledgerPath, incomplete);

  const moved = await audit.reserveRollingRules({
    auditId: 'audit-repair-cross',
    voiceId: 'voice-repair-cross',
    displayText: 'Folks, folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
    replaceReservationIds: oldIds,
  });
  assert.equal(moved.ok, true);
  const events = await audit.readLedgerAndSpoolEvents();
  for (const reservationId of oldIds) {
    assert.equal(events.some((event) =>
      event.type === 'voice.policy_reserved'
      && event.payload.reservationId === reservationId), true);
    assert.equal(events.some((event) =>
      event.type === 'voice.policy_released'
      && event.payload.reservationId === reservationId), true);
  }
});

test('cross-hour retry repairs new evidence before closing old reservations', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  const rules = [{
    id: 'folks-hour',
    type: 'station-hour-limit' as const,
    value: 'folks',
    max: 2,
  }];
  const original = await audit.reserveRollingRules({
    auditId: 'audit-cross-retry',
    voiceId: 'voice-cross-retry',
    displayText: 'Folks, folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T12:59:30.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
  });
  assert.equal(original.ok, true);
  const oldIds = original.ok
    ? original.reservations.map((reservation) => reservation.reservationId)
    : [];
  const request = {
    auditId: 'audit-cross-retry',
    voiceId: 'voice-cross-retry',
    displayText: 'Folks, folks.',
    rules,
    predictedAirtimeMs: Date.parse('2030-01-01T13:00:01.000Z'),
    expiresAtMs: Date.parse('2031-01-01T00:00:00.000Z'),
    automatic: true,
    replaceReservationIds: oldIds,
  };
  const moved = await audit.reserveRollingRules(request);
  assert.equal(moved.ok, true);
  const newIds = moved.ok
    ? moved.reservations.map((reservation) => reservation.reservationId)
    : [];
  const ledgerPath = audit.voiceAuditEventPath(Date.now());
  const incomplete = readFileSync(ledgerPath, 'utf8')
    .trimEnd()
    .split('\n')
    .filter((line) => {
      const event = JSON.parse(line);
      return !(
        (
          event.type === 'voice.policy_reserved'
          && event.payload.reservationId === newIds[0]
        )
        || (
          event.type === 'voice.policy_released'
          && event.payload.reservationId === oldIds[0]
        )
      );
    })
    .join('\n') + '\n';
  writeFileSync(ledgerPath, incomplete);

  const retry = await audit.reserveRollingRules(request);
  assert.equal(retry.ok, true);
  const events = await audit.readLedgerEvents();
  for (const reservationId of newIds) {
    assert.equal(events.some((event) =>
      event.type === 'voice.policy_reserved'
      && event.payload.reservationId === reservationId), true);
  }
  for (const reservationId of oldIds) {
    assert.equal(events.some((event) =>
      event.type === 'voice.policy_released'
      && event.payload.reservationId === reservationId), true);
  }
});

test('restart recovery expires only unreferenced reservations after complete reference discovery', async () => {
  setStationTimezone('UTC');
  await enableAutomaticAudit();
  // Keep every predicted airtime inside one deterministic future UTC hour,
  // even when the full suite happens to cross a wall-clock hour boundary.
  const now = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 60_000;
  const reserved = await audit.reserveRollingRules({
    auditId: 'audit-a',
    voiceId: 'voice-a',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 1_000,
    expiresAtMs: now + 5_000,
    automatic: true,
  });
  assert.equal(reserved.ok, true);
  const id = reserved.ok ? reserved.reservations[0].reservationId : '';
  assert.equal(await audit.recoverExpiredRollingReservations({
    nowMs: now + 10_000,
    referencesComplete: false,
  }), 0);
  assert.equal(await audit.recoverExpiredRollingReservations({
    nowMs: now + 10_000,
    referencesComplete: true,
    queueReservationIds: new Set([id]),
  }), 0);
  const blockedWhileReferenced = await audit.reserveRollingRules({
    auditId: 'audit-b',
    voiceId: 'voice-b',
    displayText: 'Folks.',
    rules: [{ id: 'folks-hour', type: 'station-hour-limit' as const, value: 'folks', max: 1 }],
    predictedAirtimeMs: now + 11_000,
    expiresAtMs: now + 60_000,
    automatic: true,
  });
  assert.equal(blockedWhileReferenced.ok, false);
  assert.equal(blockedWhileReferenced.code, 'text_policy_failed');
  assert.equal(await audit.recoverExpiredRollingReservations({
    nowMs: now + 10_000,
    referencesComplete: true,
    handoffReservationIds: new Set([id]),
  }), 0);
  assert.equal(await audit.recoverExpiredRollingReservations({
    nowMs: now + 10_000,
    referencesComplete: true,
    arbiterLockReservationIds: new Set([id]),
  }), 0);
  const ledgerPath = audit.voiceAuditEventPath(Date.now());
  writeFileSync(
    ledgerPath,
    readFileSync(ledgerPath, 'utf8')
      .trimEnd()
      .split('\n')
      .filter((line) => {
        const event = JSON.parse(line);
        return event.type !== 'voice.policy_reserved'
          || event.payload.reservationId !== id;
      })
      .join('\n') + '\n',
  );
  assert.equal(await audit.recoverExpiredRollingReservations({
    nowMs: now + 10_000,
    referencesComplete: true,
  }), 1);
  const events = await audit.readLedgerEvents();
  assert.equal(events.some((event) =>
    event.type === 'voice.policy_reserved'
    && event.payload.reservationId === id), true);
  assert.equal(events.some((event) =>
    event.type === 'voice.policy_released'
    && event.payload.reservationId === id
    && event.payload.reason === 'expired'), true);
});

test('retention removes old ledger and torn-tail files but never touches golden', async () => {
  mkdirSync(config.voiceAudit.goldenDir, { recursive: true });
  writeFileSync(join(config.voiceAudit.dir, 'events-2026-08-01.jsonl'), '{}\n');
  writeFileSync(join(config.voiceAudit.dir, 'events-2026-08-02.jsonl'), '{}\n');
  writeFileSync(join(config.voiceAudit.dir, 'events-2026-09-05.jsonl'), '{}\n');
  writeFileSync(
    join(config.voiceAudit.dir, `torn-events-2026-08-02.jsonl-${'a'.repeat(64)}.fragment`),
    '{"torn"',
  );
  writeFileSync(config.voiceAudit.rollingReservationsFile, JSON.stringify({
    schemaVersion: 1,
    reservations: [{
      reservationId: 'active-old-reservation',
      auditId: 'active-old-audit',
      voiceId: 'active-old-voice',
      ruleId: 'folks-hour',
      value: 'folks',
      max: 1,
      stationHourKey: '2026-08-01T12+0000@UTC',
      createdAtMs: Date.parse('2026-08-01T12:00:00.000Z'),
      expiresAtMs: Date.parse('2026-10-01T12:00:00.000Z'),
    }],
  }));
  writeFileSync(join(config.voiceAudit.goldenDir, 'keep.txt'), 'keep');
  const removed = await audit.pruneVoiceAuditEvents(Date.parse('2026-09-05T12:00:00.000Z'));
  assert.equal(removed, 2);
  assert.equal(existsSync(join(config.voiceAudit.dir, 'events-2026-08-01.jsonl')), true);
  assert.equal(existsSync(join(config.voiceAudit.dir, 'events-2026-08-02.jsonl')), false);
  assert.equal(
    existsSync(join(config.voiceAudit.dir, `torn-events-2026-08-02.jsonl-${'a'.repeat(64)}.fragment`)),
    false,
  );
  assert.equal(existsSync(join(config.voiceAudit.dir, 'events-2026-09-05.jsonl')), true);
  assert.equal(readFileSync(join(config.voiceAudit.goldenDir, 'keep.txt'), 'utf8'), 'keep');
});

test('retention invalidates removed entries in the event ID index', async () => {
  const old = eventFor('voice.started');
  old.atMs = Date.parse('2026-08-01T12:00:00.000Z');
  await audit.appendLedgerEvent(old);
  assert.equal(
    await audit.pruneVoiceAuditEvents(Date.parse('2026-09-05T12:00:00.000Z')),
    1,
  );
  const current = { ...old, atMs: AT };
  await audit.appendLedgerEvent(current);
  assert.deepEqual(
    (await audit.readLedgerEvents()).map((event) => event.atMs),
    [AT],
  );
});

test('golden pin refuses missing mixer capability before blessing estimated evidence', async () => {
  const archive = join(stateRoot, 'hour.mp3');
  writeFileSync(archive, 'archive');
  const staleStaging = join(
    config.voiceAudit.goldenDir,
    `.${HOUR}.2147483647.${'c'.repeat(12)}.tmp`,
  );
  mkdirSync(join(staleStaging, 'artifacts'), { recursive: true });
  writeFileSync(join(staleStaging, 'orphaned-archive.bin'), 'stale');
  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  utimesSync(staleStaging, staleTime, staleTime);
  const pinWithoutCapabilities = {
    hour: HOUR,
    archivePath: archive,
    measurements: {
      schemaVersion: 1 as const,
      stationHourKey: HOUR,
      archiveStartedAtMs: HOUR_START,
      archiveEndedAtMs: HOUR_END,
      archiveDurationMs: HOUR_END - HOUR_START,
      archiveSha256: hash('archive'),
      integratedLufs: -17,
      truePeakDbtp: -1.2,
      measuredAt: new Date(HOUR_END + 1_000).toISOString(),
      tool: 'independent ffmpeg',
    },
  };
  await assert.rejects(
    () => audit.pinGoldenHour(pinWithoutCapabilities),
    /correlated voice-end capability is unavailable/,
  );
  assert.equal(existsSync(staleStaging), false);
  assert.deepEqual(readdirSync(config.voiceAudit.goldenDir), []);

  rmSync(config.voiceAudit.goldenDir, { recursive: true, force: true });
  const outsideGolden = mkdtempSync(join(tmpdir(), 'subwave-golden-outside-'));
  const outsideStaging = join(
    outsideGolden,
    `.${HOUR}.2147483647.${'e'.repeat(12)}.tmp`,
  );
  mkdirSync(outsideStaging);
  writeFileSync(join(outsideStaging, 'must-remain.txt'), 'outside');
  utimesSync(outsideStaging, staleTime, staleTime);
  symlinkSync(outsideGolden, config.voiceAudit.goldenDir);
  await assert.rejects(
    () => audit.pinGoldenHour(pinWithoutCapabilities),
    /symbolic links|ELOOP|ENOTDIR|durable directory/,
  );
  assert.equal(
    readFileSync(join(outsideStaging, 'must-remain.txt'), 'utf8'),
    'outside',
  );
  rmSync(config.voiceAudit.goldenDir, { force: true });
  rmSync(outsideGolden, { recursive: true, force: true });
});

test('golden pin verifies measured pairs, artifacts, hashes, settings, and publishes atomically', async () => {
  const archive = join(stateRoot, 'hour.mp3');
  writeFileSync(archive, 'archive');
  writeFileSync(join(stateRoot, 'capabilities.json'), JSON.stringify({
    schemaVersion: 1,
    mixerBootTime: AT / 1_000,
    bootSettings: { voiceBreaksEnabled: false },
    features: {
      correlatedVoiceEnd: { supported: true, active: true },
      voicePendingLatch: { supported: true, active: true },
      atomicBreakBatch: { supported: false, active: false },
      breakStartEnd: { supported: false, active: false },
      playoutCompletion: { supported: true, active: true },
    },
  }));
  writeFileSync(join(stateRoot, 'settings.json'), JSON.stringify({
    timezone: 'America/Winnipeg',
    tts: {
      cloud: {
        apiKey: 'top-secret',
        privateKey: 'direct-private-secret',
        accessKeyId: 'direct-access-id-secret',
        subscriptionKey: 'direct-subscription-secret',
        secretKey: 'direct-secret-key',
        signingKey: 'direct-signing-key',
        consumerKey: 'direct-consumer-key',
        serviceAccountKey: 'direct-service-key',
        credentialValue: 'direct-credential-value',
        secretkey: 'direct-lower-secret-key',
        clientsecret: 'direct-client-secret',
        refreshtoken: 'direct-refresh-token',
        compatApiKey: 'compat-secret',
        baseUrl: `https://example.test/v1?token=${'a'.repeat(32)}`,
        mirrorUrl: 'https://example.test/v1?x-api-key=header-secret',
        compatParams: [
          { key: 'authorization', value: 'compat-param-secret' },
          { key: 'privateKey', value: 'private-key-secret' },
        ],
        compatHeaders: [{ name: 'x-api-key', value: 'named-param-secret' }],
      },
      broadcastQa: { enabled: true, replacements: [], rules: [] },
    },
    personas: [{
      id: 'host',
      name: 'Host',
      tts: {
        engine: 'cloud',
        voice: '/Users/operator/private-voice.wav',
        apiKey: 'persona-secret',
      },
    }],
  }));
  const artifactBytes = Buffer.from('audio');
  const artifactPath = join(stateRoot, 'voice', 'artifacts', 'audit-1-deadbeef.wav');
  mkdirSync(join(stateRoot, 'voice', 'artifacts'), { recursive: true });
  writeFileSync(artifactPath, artifactBytes);
  chmodSync(artifactPath, 0o444);
  const pinInput = {
    hour: HOUR,
    archivePath: archive,
    measurements: {
      schemaVersion: 1 as const,
      stationHourKey: HOUR,
      archiveStartedAtMs: HOUR_START,
      archiveEndedAtMs: HOUR_END,
      archiveDurationMs: HOUR_END - HOUR_START,
      archiveSha256: hash('archive'),
      integratedLufs: -17,
      truePeakDbtp: -1.2,
      measuredAt: new Date(HOUR_END + 1_000).toISOString(),
      tool: 'independent ffmpeg',
    },
  };
  await assert.rejects(
    () => audit.pinGoldenHour({
      ...pinInput,
      measurements: {
        ...pinInput.measurements,
        measuredAt: 'not-an-ISO-timestamp',
      },
    }),
    /canonical UTC ISO timestamp/,
  );
  await assert.rejects(
    () => audit.pinGoldenHour({
      ...pinInput,
      measurements: {
        ...pinInput.measurements,
        measuredAt: new Date(AT).toISOString(),
      },
    }),
    /must follow archive completion and precede pinning/,
  );
  await assert.rejects(
    () => audit.pinGoldenHour({
      ...pinInput,
      measurements: {
        ...pinInput.measurements,
        measuredAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }),
    /must follow archive completion and precede pinning/,
  );
  const archiveAlias = `${archive}.alias`;
  linkSync(archive, archiveAlias);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /one-link regular file/,
  );
  rmSync(archiveAlias);
  const settingsAlias = join(stateRoot, 'settings-hardlink.json');
  linkSync(join(stateRoot, 'settings.json'), settingsAlias);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /settings snapshot is unavailable/,
  );
  rmSync(settingsAlias);
  await assert.rejects(
    () => audit.pinGoldenHour({
      ...pinInput,
      measurements: {
        ...pinInput.measurements,
        tool: 'ffmpeg at /Users/operator/private/bin/ffmpeg',
      },
    }),
    /private host or credential data/,
  );
  await assert.rejects(
    () => audit.pinGoldenHour({
      ...pinInput,
      measurements: {
        ...pinInput.measurements,
        tool: 'error: {"name":"x-api-key","value":"golden-secret"}',
      },
    }),
    /private host or credential data/,
  );
  await assert.rejects(
    () => audit.pinGoldenHour({
      ...pinInput,
      measurements: {
        ...pinInput.measurements,
        stationHourKey: '2026-09-05T15-0500@America_Winnipeg',
      },
    }),
    /do not cover the selected station hour/,
  );

  await audit.appendLedgerEvent(base('voice.artifact', {
    artifact: artifact({
      auditId: 'different-audit',
      sha256: hash(artifactBytes),
    }),
  }, { auditId: 'different-audit' }));
  await audit.appendLedgerEvent(eventFor('voice.started'));
  await audit.appendLedgerEvent(eventFor('voice.ended'));
  await assert.rejects(() => audit.pinGoldenHour(pinInput), /artifact correlation changed/);
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();

  await audit.appendLedgerEvent(base('voice.artifact', {
    artifact: artifact({ sha256: hash(artifactBytes) }),
  }));
  const lateStart = eventFor('voice.started');
  const lateEnd = eventFor('voice.ended');
  if (lateStart.type === 'voice.started') {
    lateStart.payload.clipStartedAt += 2 * 60 * 60 * 1_000;
    lateStart.payload.audibleStartedAt += 2 * 60 * 60 * 1_000;
  }
  if (lateEnd.type === 'voice.ended') {
    lateEnd.payload.clipEndedAt += 2 * 60 * 60 * 1_000;
    if (lateEnd.payload.audibleEndedAt !== undefined) {
      lateEnd.payload.audibleEndedAt += 2 * 60 * 60 * 1_000;
    }
  }
  await audit.appendLedgerEvent(lateStart);
  await audit.appendLedgerEvent(lateEnd);
  await assert.rejects(() => audit.pinGoldenHour(pinInput), /outside the selected station hour/);
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();

  const miskeyedStart = eventFor('voice.started');
  const miskeyedEnd = eventFor('voice.ended');
  miskeyedStart.stationHourKey = PREVIOUS_HOUR;
  miskeyedEnd.stationHourKey = PREVIOUS_HOUR;
  await audit.appendLedgerEvent(miskeyedStart);
  await audit.appendLedgerEvent(miskeyedEnd);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /misstates its key/,
  );
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();

  const crossingStart = eventFor('voice.started');
  const crossingEnd = eventFor('voice.ended');
  crossingStart.stationHourKey = PREVIOUS_HOUR;
  crossingEnd.stationHourKey = PREVIOUS_HOUR;
  if (crossingStart.type === 'voice.started') {
    crossingStart.payload.clipStartedAt = HOUR_START - 1_000;
    crossingStart.payload.audibleStartedAt = HOUR_START - 920;
  }
  if (crossingEnd.type === 'voice.ended') {
    crossingEnd.payload.clipEndedAt = HOUR_START + 4_000;
    crossingEnd.payload.audibleEndedAt = HOUR_START + 3_880;
  }
  await audit.appendLedgerEvent(crossingStart);
  await audit.appendLedgerEvent(crossingEnd);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /outside the selected station hour/,
  );
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();

  const spanningStart = eventFor('voice.started');
  const spanningEnd = eventFor('voice.ended');
  spanningStart.stationHourKey = PREVIOUS_HOUR;
  spanningEnd.stationHourKey = '2026-09-05T15-0500@America_Winnipeg';
  spanningStart.atMs = HOUR_START - 120_000;
  spanningEnd.atMs = HOUR_END + 120_000;
  if (spanningStart.type === 'voice.started') {
    spanningStart.payload.clipStartedAt = HOUR_START - 120_000;
    spanningStart.payload.audibleStartedAt = HOUR_START - 119_920;
  }
  if (spanningEnd.type === 'voice.ended') {
    spanningEnd.payload.clipEndedAt = HOUR_END + 120_000;
    spanningEnd.payload.audibleEndedAt = HOUR_END + 119_880;
  }
  await audit.appendLedgerEvent(spanningStart);
  await audit.appendLedgerEvent(spanningEnd);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /outside the selected station hour/,
  );
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();

  const boundaryOrphanEnd = eventFor('voice.ended');
  boundaryOrphanEnd.stationHourKey =
    '2026-09-05T15-0500@America_Winnipeg';
  boundaryOrphanEnd.atMs = HOUR_END + 30_000;
  if (boundaryOrphanEnd.type === 'voice.ended') {
    boundaryOrphanEnd.payload.clipEndedAt = HOUR_END + 30_000;
    boundaryOrphanEnd.payload.audibleEndedAt = HOUR_END + 29_880;
  }
  await audit.appendLedgerEvent(boundaryOrphanEnd);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /has no correlated voice.started/,
  );
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();

  await audit.appendLedgerEvent(eventFor('voice.started'));
  await audit.appendLedgerEvent(eventFor('voice.ended'));
  const contradictoryDrop = eventFor('voice.dropped');
  contradictoryDrop.voiceId = 'voice-1';
  await audit.appendLedgerEvent(contradictoryDrop);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /conflicting dropped evidence/,
  );
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();

  await audit.appendLedgerEvent(eventFor('voice.started'));
  await audit.appendLedgerEvent(eventFor('voice.ended'));
  const conflictingEnd = eventFor('voice.ended');
  conflictingEnd.eventId = `${conflictingEnd.eventId}-interrupted`;
  if (conflictingEnd.type === 'voice.ended') {
    conflictingEnd.payload.reason = 'interrupted';
  }
  await audit.appendLedgerEvent(conflictingEnd);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /duplicate voice.ended/,
  );
  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();

  const wrongArtifact = base('voice.artifact', {
    artifact: artifact({
      sha256: hash(artifactBytes),
      createdAt: new Date(AT + 600).toISOString(),
    }),
  }, { atMs: AT + 600 });
  const wrongStart = eventFor('voice.started');
  wrongStart.atMs = AT + 1_000;
  const wrongEnd = eventFor('voice.ended');
  wrongEnd.atMs = AT + 6_000;
  await audit.appendLedgerEvent(wrongArtifact);
  await audit.appendLedgerEvent(wrongStart);
  await audit.appendLedgerEvent(wrongEnd);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /no unique accepted QA audit chain/,
  );
  const wrongTextPolicy = eventFor('voice.text_policy');
  wrongTextPolicy.atMs = AT + 50;
  await audit.appendLedgerEvent(wrongTextPolicy);
  const wrongTarget = eventFor('voice.render_attempt');
  if (wrongTarget.type === 'voice.render_attempt') {
    wrongTarget.payload.engine = 'piper';
    wrongTarget.payload.startedAtMs = AT + 100;
    wrongTarget.payload.endedAtMs = AT + 500;
  }
  wrongTarget.atMs = AT + 500;
  await audit.appendLedgerEvent(wrongTarget);
  const wrongQaPassed = eventFor('voice.qa_passed');
  wrongQaPassed.atMs = AT + 550;
  await audit.appendLedgerEvent(wrongQaPassed);
  const wrongQueued = eventFor('voice.queued');
  wrongQueued.atMs = AT + 700;
  if (wrongQueued.type === 'voice.queued') {
    wrongQueued.payload.queuedAtMs = AT + 700;
  }
  await audit.appendLedgerEvent(wrongQueued);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /accepted QA evidence does not match its artifact/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  const appendAcceptedChain = async (
    rewriteCount: 0 | 1 = 0,
    endClipDeltaMs = 0,
    artifactHour = HOUR,
    includeFailedAttempt = false,
    startEnvelopeOffsetMs = 0,
    rewriteOffsetMs?: number,
  ) => {
    const capturedAtMs = artifactHour === HOUR
      ? AT
      : HOUR_START - 10_000;
    const finalText = rewriteCount === 1 ? 'Hi there.' : 'Hello.';
    const renderStartedAtMs = capturedAtMs + 100;
    const renderEndedAtMs = renderStartedAtMs + 5_000;
    const artifactAtMs = renderEndedAtMs + 100;
    const queuedAtMs = AT + 7_000;
    const clipStartedAtMs = AT + 8_000;
    const textPolicy = eventFor('voice.text_policy');
    textPolicy.atMs = capturedAtMs + 50;
    textPolicy.stationHourKey = artifactHour;
    if (textPolicy.type === 'voice.text_policy') {
      textPolicy.payload.renderSnapshot.capturedAtMs = capturedAtMs;
      textPolicy.payload.displayText = finalText;
      textPolicy.payload.displayTextHash = canonicalHash(finalText);
      textPolicy.payload.spokenTextHash = canonicalHash(finalText);
    }
    const rewrite = eventFor('voice.rewrite');
    rewrite.atMs = capturedAtMs + (rewriteOffsetMs ?? 0);
    rewrite.stationHourKey = artifactHour;
    if (rewrite.type === 'voice.rewrite') {
      rewrite.payload.beforeHash = canonicalHash('Hello.');
      rewrite.payload.afterHash = canonicalHash(finalText);
    }
    const renderAttempt = eventFor('voice.render_attempt');
    renderAttempt.atMs = renderEndedAtMs;
    renderAttempt.stationHourKey = artifactHour;
    if (renderAttempt.type === 'voice.render_attempt') {
      renderAttempt.payload.startedAtMs = renderStartedAtMs;
      renderAttempt.payload.endedAtMs = renderEndedAtMs;
      renderAttempt.payload.textHash = canonicalHash(finalText);
    }
    const failedAttempt = base('voice.render_attempt', {
      ...attempt('failed'),
      targetKey: 'piper:en_GB-alan-medium',
      engine: 'piper',
      voice: 'en_GB-alan-medium',
      startedAtMs: capturedAtMs + 60,
      endedAtMs: capturedAtMs + 90,
    }, {
      atMs: capturedAtMs + 90,
      stationHourKey: artifactHour,
    });
    const qaPassed = eventFor('voice.qa_passed');
    qaPassed.atMs = renderEndedAtMs + 50;
    qaPassed.stationHourKey = artifactHour;
    const artifactEvent = base('voice.artifact', {
      artifact: artifact({
        sha256: hash(artifactBytes),
        displayText: finalText,
        spokenText: finalText,
        rewriteCount,
        createdAt: new Date(artifactAtMs).toISOString(),
        renderSnapshot: {
          ...snapshot(),
          capturedAtMs,
        },
      }),
    }, {
      stationHourKey: artifactHour,
      atMs: artifactAtMs,
    });
    const queued = eventFor('voice.queued');
    queued.atMs = queuedAtMs + 1;
    if (queued.type === 'voice.queued') {
      queued.payload.queuedAtMs = queuedAtMs;
    }
    const started = eventFor('voice.started');
    started.atMs = clipStartedAtMs + startEnvelopeOffsetMs;
    if (started.type === 'voice.started') {
      started.payload.clipStartedAt = clipStartedAtMs;
      started.payload.audibleStartedAt = clipStartedAtMs + 80;
    }
    const ended = eventFor('voice.ended');
    ended.atMs = clipStartedAtMs + 5_000 + endClipDeltaMs;
    if (ended.type === 'voice.ended') {
      ended.payload.clipEndedAt = clipStartedAtMs + 5_000 + endClipDeltaMs;
      ended.payload.audibleEndedAt = clipStartedAtMs + 4_880;
    }
    for (const event of [
      textPolicy,
      ...(rewriteOffsetMs === undefined ? [] : [rewrite]),
      ...(includeFailedAttempt ? [failedAttempt] : []),
      renderAttempt,
      qaPassed,
      artifactEvent,
      queued,
      started,
      ended,
    ]) {
      await audit.appendLedgerEvent(event);
    }
    await audit.persistVoiceSettingsSnapshot(
      snapshot().settingsHash,
      RENDER_SETTINGS_SNAPSHOT,
    );
  };
  await assert.rejects(
    () => audit.persistVoiceSettingsSnapshot(
      hash('unrelated-settings'),
      RENDER_SETTINGS_SNAPSHOT,
    ),
    /settings snapshot hash does not match/,
  );
  await appendAcceptedChain();
  const unkeyedDrop = eventFor('voice.dropped');
  unkeyedDrop.voiceId = undefined;
  await audit.appendLedgerEvent(unkeyedDrop);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /contradictory terminal failure evidence/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain();
  await audit.appendLedgerEvent(base('voice.artifact', {
    artifact: artifact({
      artifactId: 'artifact-extra',
      path: 'voice/artifacts/artifact-extra.wav',
      sha256: hash('extra-artifact'),
      createdAt: new Date(AT + 5_150).toISOString(),
    }),
  }, { atMs: AT + 5_150 }));
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /no unique accepted QA audit chain/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain();
  const lateRejectedPolicy = eventFor('voice.text_policy');
  lateRejectedPolicy.atMs = AT + 9_000;
  if (lateRejectedPolicy.type === 'voice.text_policy') {
    lateRejectedPolicy.payload.outcome = 'rejected';
  }
  await audit.appendLedgerEvent(lateRejectedPolicy);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /no unique accepted QA audit chain/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain();
  await audit.appendLedgerEvent(base('voice.render_attempt', {
    ...attempt('failed'),
    targetKey: 'piper:late',
    engine: 'piper',
    startedAtMs: AT + 9_000,
    endedAtMs: AT + 9_500,
  }, { atMs: AT + 9_500 }));
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /render attempt chronology is inconsistent/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain(0, 0, HOUR, false, 6_000);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /audit chronology is inconsistent/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain(0, audit.GOLDEN_MARKER_TOLERANCE_MS + 1);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /playout geometry does not match its artifact/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain(0, audit.GOLDEN_MARKER_TOLERANCE_MS);
  rmSync(config.voiceAudit.settingsSnapshotsDir, { recursive: true, force: true });
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /historical voice settings snapshot is unavailable/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain();
  const componentLedger = audit.voiceAuditEventPath(AT);
  writeFileSync(
    componentLedger,
    readFileSync(componentLedger, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const event = JSON.parse(line);
        if (event.type === 'voice.text_policy') {
          event.payload.renderSnapshot.policyHash = hash('unrelated-policy');
        }
        if (event.type === 'voice.artifact') {
          event.payload.artifact.renderSnapshot.policyHash = hash('unrelated-policy');
        }
        return JSON.stringify(event);
      })
      .join('\n') + '\n',
  );
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /historical voice settings policy hash does not match render evidence/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain();
  const chronologyLedger = audit.voiceAuditEventPath(AT);
  writeFileSync(
    chronologyLedger,
    readFileSync(chronologyLedger, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const event = JSON.parse(line);
        if (event.type === 'voice.render_attempt') {
          event.payload.endedAtMs = AT + 14_000;
        }
        return JSON.stringify(event);
      })
      .join('\n') + '\n',
  );
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /render attempt chronology is inconsistent/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain();
  const unrelatedSettingsHash = hash('unrelated-settings-snapshot');
  const settingsLedger = audit.voiceAuditEventPath(AT);
  writeFileSync(
    settingsLedger,
    readFileSync(settingsLedger, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => {
        const event = JSON.parse(line);
        if (event.type === 'voice.text_policy') {
          event.payload.renderSnapshot.settingsHash = unrelatedSettingsHash;
        }
        if (event.type === 'voice.artifact') {
          event.payload.artifact.renderSnapshot.settingsHash = unrelatedSettingsHash;
        }
        return JSON.stringify(event);
      })
      .join('\n') + '\n',
  );
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /historical voice settings snapshot is unavailable/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain(1);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /rewrite history does not match its artifact/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain(1, 0, HOUR, false, 0, -1);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /audit chronology is inconsistent/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain();
  await audit.appendLedgerEvent(eventFor('voice.rewrite'));
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /rewrite history does not match its artifact/,
  );

  rmSync(config.voiceAudit.dir, { recursive: true, force: true });
  audit.resetVoiceAuditLedgerForTests();
  await appendAcceptedChain(
    1,
    audit.GOLDEN_MARKER_TOLERANCE_MS,
    PREVIOUS_HOUR,
    true,
    0,
    55,
  );
  const laterUnfinished = eventFor('voice.started');
  laterUnfinished.auditId = 'audit-later-hour';
  laterUnfinished.voiceId = 'voice-later-hour';
  laterUnfinished.stationHourKey = '2026-09-05T17-0500@America_Winnipeg';
  laterUnfinished.atMs = HOUR_END + 2 * 60 * 60 * 1_000;
  if (laterUnfinished.type === 'voice.started') {
    laterUnfinished.payload.clipStartedAt = HOUR_END + 2 * 60 * 60 * 1_000;
    laterUnfinished.payload.audibleStartedAt =
      laterUnfinished.payload.clipStartedAt + 80;
  }
  await audit.appendLedgerEvent(laterUnfinished);
  const artifactAlias = `${artifactPath}.alias`;
  linkSync(artifactPath, artifactAlias);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /one-link regular file/,
  );
  rmSync(artifactAlias);
  chmodSync(artifactPath, 0o644);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /artifact must be read-only/,
  );
  chmodSync(artifactPath, 0o444);

  const staleStaging = join(
    config.voiceAudit.goldenDir,
    `.${HOUR}.${'a'.repeat(12)}.tmp`,
  );
  mkdirSync(join(staleStaging, 'artifacts'), { recursive: true });
  writeFileSync(join(staleStaging, 'orphaned-archive.bin'), 'stale');
  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
  utimesSync(staleStaging, staleTime, staleTime);
  const deadOwnerStaging = join(
    config.voiceAudit.goldenDir,
    `.${HOUR}.2147483647.${'b'.repeat(12)}.tmp`,
  );
  mkdirSync(join(deadOwnerStaging, 'artifacts'), { recursive: true });
  writeFileSync(join(deadOwnerStaging, 'orphaned-archive.bin'), 'stale');
  utimesSync(deadOwnerStaging, staleTime, staleTime);
  const recentStaging = join(
    config.voiceAudit.goldenDir,
    `.${HOUR}.${process.pid}.${'d'.repeat(12)}.tmp`,
  );
  mkdirSync(join(recentStaging, 'artifacts'), { recursive: true });
  writeFileSync(join(recentStaging, 'active-archive.bin'), 'active');

  const pinned = await audit.pinGoldenHour(pinInput);
  assert.equal(existsSync(staleStaging), false);
  assert.equal(existsSync(deadOwnerStaging), false);
  assert.equal(existsSync(recentStaging), true);
  const sealPath = `${pinned.directory}.sha256`;
  assert.equal(existsSync(join(pinned.directory, 'manifest.json')), true);
  assert.equal(existsSync(sealPath), true);
  assert.equal(existsSync(join(pinned.directory, 'audit.jsonl')), true);
  assert.equal(existsSync(join(pinned.directory, 'artifacts', 'audit-1-deadbeef.wav')), true);
  assert.equal(
    pinned.manifest.audit.sha256,
    hash(readFileSync(join(pinned.directory, pinned.manifest.audit.file))),
  );
  assert.equal(
    pinned.manifest.archive.sha256,
    hash(readFileSync(join(pinned.directory, pinned.manifest.archive.file))),
  );
  const settingsEvidence = readFileSync(
    join(pinned.directory, pinned.manifest.settings.file),
    'utf8',
  );
  assert.doesNotMatch(
    settingsEvidence,
    /top-secret|direct-private-secret|direct-access-id-secret|direct-subscription-secret|direct-secret-key|direct-signing-key|direct-consumer-key|direct-service-key|direct-credential-value|direct-lower-secret-key|direct-client-secret|direct-refresh-token|compat-secret|compat-param-secret|private-key-secret|header-secret|named-param-secret|persona-secret|\/Users\/operator/,
  );
  assert.match(settingsEvidence, /<redacted-signed-url>|<redacted-path>/);
  assert.match(settingsEvidence, /"historicalSettings"/);
  assert.match(settingsEvidence, /"artifactRenderSnapshots"/);
  assert.equal(pinned.manifest.artifacts[0].sha256, hash(artifactBytes));
  assert.equal(
    readFileSync(sealPath, 'utf8'),
    `${hash(readFileSync(join(pinned.directory, 'manifest.json')))}  `
      + `${HOUR}/manifest.json\n`,
  );
  for (const path of [
    pinned.directory,
    sealPath,
    join(pinned.directory, 'artifacts'),
    join(pinned.directory, 'manifest.json'),
    join(pinned.directory, pinned.manifest.archive.file),
    join(pinned.directory, pinned.manifest.audit.file),
    join(pinned.directory, pinned.manifest.artifacts[0].file),
  ]) {
    assert.equal(statSync(path).mode & 0o222, 0, `${path} must be read-only`);
  }
  for (const evidence of [
    pinned.manifest.settings,
    pinned.manifest.capabilities,
    pinned.manifest.measurements,
  ]) {
    assert.equal(evidence.sha256, hash(readFileSync(join(pinned.directory, evidence.file))));
  }
  await assert.rejects(
    () => audit.pinGoldenHour({
      hour: HOUR,
      archivePath: archive,
      measurements: {
        schemaVersion: 1,
        stationHourKey: HOUR,
        archiveStartedAtMs: HOUR_START,
        archiveEndedAtMs: HOUR_END,
        archiveDurationMs: HOUR_END - HOUR_START,
        archiveSha256: hash('archive'),
        integratedLufs: -17,
        truePeakDbtp: -1.2,
        measuredAt: new Date(HOUR_END + 1_000).toISOString(),
        tool: 'independent ffmpeg',
      },
    }),
    /already pinned/,
  );
  const pinnedSettings = join(pinned.directory, pinned.manifest.settings.file);
  chmodSync(pinnedSettings, 0o644);
  appendFileSync(pinnedSettings, 'tampered\n');
  chmodSync(pinnedSettings, 0o444);
  await assert.rejects(
    () => audit.pinGoldenHour(pinInput),
    /incomplete or writable pin requiring operator review.*member hash changed/,
  );
  // Restore test-fixture directory write bits so the process can remove its
  // temporary state tree. Production golden bundles remain non-writable.
  chmodSync(join(pinned.directory, 'artifacts'), 0o755);
  chmodSync(pinned.directory, 0o755);
});

process.on('exit', () => rmSync(stateRoot, { recursive: true, force: true }));
