// Pins the disabled broadcast-QA path before any production refactor.
//
// Capture the current speak / Queue / /dj/say / talkTick / voice-event
// contract from unmodified develop. Production changes must keep matching
// these snapshots when tts.broadcastQa is absent, malformed, or explicitly
// false. A host Piper binary is never used — PIPER_BIN is a deterministic
// fake that writes a fixed WAV and records each invocation.
//
// Run: npx tsx scripts/voice-qa-disabled-compat.test.ts

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import test, { after } from 'node:test';
import express from 'express';

const STATE = mkdtempSync(join(tmpdir(), 'subwave-voice-qa-disabled-'));
const FAKE_PIPER = join(STATE, 'fake-piper');
const CALL_LOG = join(STATE, 'piper-calls.jsonl');
process.env.STATE_DIR = STATE;
process.env.PIPER_BIN = FAKE_PIPER;
mkdirSync(join(STATE, 'voice'), { recursive: true });

writeFileSync(FAKE_PIPER, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const out = process.argv.includes('--output_file')
  ? process.argv[process.argv.indexOf('--output_file') + 1]
  : path.join(${JSON.stringify(join(STATE, 'voice'))}, 'fallback.wav');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const text = Buffer.concat(chunks).toString('utf8');
  fs.appendFileSync(${JSON.stringify(CALL_LOG)}, JSON.stringify({ engine: 'piper', text, outPath: out }) + '\\n');
  const dataBytes = 16000;
  const sample = 16000;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < dataBytes; i += 2) buf.writeInt16LE(sample, 44 + i);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
});
`);
chmodSync(FAKE_PIPER, 0o755);
writeFileSync(CALL_LOG, '');

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const tts = await import('../src/audio/tts.js');
const remoteTts = await import('../src/audio/remoteTts.js');
const { applyEdgeFades } = await import('../src/audio/wav-edges.js');
const { voiceUri } = await import('../src/broadcast/queue/voice-io.js');
const { notifyQueued, notifySpoken } = await import('../src/broadcast/voice-events.js');
const { talkTickPlan } = await import('../src/broadcast/talk-scheduler.js');
const { executeTalkTick } = await import('../src/broadcast/scheduler.js');
const { queue } = await import('../src/broadcast/queue.js');
const { router: djRouter } = await import('../src/routes/dj.js');
const { config } = await import('../src/config.js');

const SETTINGS_PATH = join(STATE, 'settings.json');
const FIXED_OUT = join(STATE, 'voice', 'compat-primary.wav');
const FIXED_FALLBACK_OUT = join(STATE, 'voice', 'compat-fallback.wav');
const FIXED_NOW = Date.parse('2026-01-15T18:15:00.000Z');
const SAY_TEXT = 'hello from the booth';
const INTRO_TEXT = 'Next up, a quiet one.';

type SpeakCall = { engine: string; text: string; outPath: string };
type CompatSnapshot = {
  primaryCalls: SpeakCall[];
  fallbackCalls: SpeakCall[];
  filename: string;
  sha256: string;
  fadedSha256: string;
  voiceUriZero: string;
  voiceUriGain: string;
  queueJson: unknown;
  sayBody: unknown;
  talkTick: unknown;
  voiceQueued: Record<string, unknown>;
  voiceStart: Record<string, unknown>;
  voiceEnd: Record<string, unknown>;
};

function currentDevelopGolden(): CompatSnapshot {
  return {
    primaryCalls: [
      { engine: 'piper', text: SAY_TEXT, outPath: FIXED_OUT },
    ],
    fallbackCalls: [
      { engine: 'remote', text: SAY_TEXT, outPath: FIXED_FALLBACK_OUT },
      { engine: 'piper', text: SAY_TEXT, outPath: FIXED_FALLBACK_OUT },
    ],
    filename: FIXED_OUT,
    sha256: '0b94e884175c99fbc77881a021bf9059472aedf23c07849d05bbbdb0b4f83a5a',
    fadedSha256: '0b94e884175c99fbc77881a021bf9059472aedf23c07849d05bbbdb0b4f83a5a',
    voiceUriZero: `annotate:subwave_voice="compat-voice":${FIXED_OUT}`,
    voiceUriGain: `annotate:liq_amplify="-3 dB",subwave_voice="compat-voice":${FIXED_OUT}`,
    queueJson: {
      upcoming: [{
        track: { id: 't1', title: 'Quiet One', artist: 'Local Band' },
        requestedBy: null,
        intent: null,
        introScript: INTRO_TEXT,
        introKind: 'link',
        introPersona: null,
        aiPicked: false,
        linkPrev: null,
        linkClockAt: null,
        introWav: FIXED_OUT,
        introAired: false,
        queuedAt: '2026-01-15T18:15:00.000Z',
        sent: false,
        confirmedInLiquidsoap: false,
      }],
      current: null,
      history: [],
      savedAt: '2026-01-15T18:15:00.000Z',
    },
    sayBody: {
      ok: true,
      mode: 'raw',
      kind: 'dj-speak',
      spoken: SAY_TEXT,
      sfx: null,
    },
    talkTick: {
      plans: [{
        kind: 'station-id',
        act: 'fire',
        slot: '15',
        slotKey: 'station-id-2026-1-15-12-15',
        gap: { clear: true, sinceMs: null, needMs: 180_000 },
        air: 'next-track',
      }],
      dispatched: [{
        kind: 'station-id',
        slot: '15',
        claimed: 'station-id-2026-1-15-12-15',
      }],
      logs: [],
      fired: { 'station-id': 'station-id-2026-1-15-12-15' },
      logged: {},
    },
    voiceQueued: {
      event: 'voice.queued',
      t: '2026-01-15T18:15:00.000Z',
      voiceId: 'compat-voice',
      kind: 'dj-speak',
      channel: 'say',
      text: SAY_TEXT,
      durationMs: 20,
      estimatedAirInMs: 1050,
      expectedAirAt: '2026-01-15T18:15:01.050Z',
      estimated: true,
      streamBufferSeconds: 22,
    },
    voiceStart: {
      event: 'voice.start',
      t: '2026-01-15T18:15:00.000Z',
      voiceId: 'compat-voice',
      kind: 'dj-speak',
      channel: 'say',
      durationMs: 20,
      airedAt: '2026-01-15T18:15:00.000Z',
      estimated: false,
      text: SAY_TEXT,
      endsAt: '2026-01-15T18:15:00.020Z',
      streamBufferSeconds: 22,
    },
    voiceEnd: {
      event: 'voice.end',
      t: '2026-01-15T18:15:00.000Z',
      voiceId: 'compat-voice',
      kind: 'dj-speak',
      channel: 'say',
      durationMs: 20,
      airedAt: '2026-01-15T18:15:00.000Z',
      estimated: false,
      endedAt: '2026-01-15T18:15:00.020Z',
    },
  };
}

function pcmWav(dataBytes: number, sampleRate = 8_000, sample = 16_000): Buffer {
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < dataBytes; i += 2) buf.writeInt16LE(sample, 44 + i);
  return buf;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function withFixedDate<T>(fn: () => Promise<T>): Promise<T> {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(value?: string | number) {
      super(value === undefined ? FIXED_NOW : value);
    }
    static now() {
      return FIXED_NOW;
    }
  }
  globalThis.Date = FixedDate as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

function writeSettings(broadcastQa?: unknown) {
  const ttsBlock: Record<string, unknown> = {
    enabled: true,
    defaultEngine: 'piper',
    fallback: { enabled: false, engine: 'piper', voice: '', cloudProvider: 'openai' },
  };
  if (arguments.length > 0) ttsBlock.broadcastQa = broadcastQa;
  writeFileSync(SETTINGS_PATH, JSON.stringify({ tts: ttsBlock }));
}

async function coldLoad(variant: 'absent' | 'malformed' | 'false') {
  if (variant === 'absent') writeSettings();
  else if (variant === 'malformed') writeSettings({ enabled: 'yes', profiles: { talkup: { maxMs: 99_999 } } });
  else writeSettings({ enabled: false, replacements: [], rules: [] });
  setCache(null);
  await settings.load();
}

function readSpeakCalls(): SpeakCall[] {
  const raw = readFileSync(CALL_LOG, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as SpeakCall);
}

function resetSpeakCalls() {
  writeFileSync(CALL_LOG, '');
}

async function persistedQueueSnapshot() {
  rmSync(config.queue.file, { force: true });
  queue.upcoming = [];
  queue.current = null;
  queue.history = [];
  const originalDrain = queue.drainToLiquidsoap.bind(queue);
  (queue as { drainToLiquidsoap: typeof queue.drainToLiquidsoap }).drainToLiquidsoap =
    (async () => {}) as typeof queue.drainToLiquidsoap;
  try {
    await withFixedDate(async () => {
      const depth = await queue.push({
        track: { id: 't1', title: 'Quiet One', artist: 'Local Band' },
        introScript: INTRO_TEXT,
        introKind: 'link',
      });
      assert.equal(depth, 1);
      queue.upcoming[0].introWav = FIXED_OUT;
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    return JSON.parse(readFileSync(config.queue.file, 'utf8'));
  } finally {
    (queue as { drainToLiquidsoap: typeof queue.drainToLiquidsoap }).drainToLiquidsoap =
      originalDrain;
  }
}

async function saySuccessBody(): Promise<unknown> {
  const original = queue.announce.bind(queue);
  const calls: Array<{ text: string; kind: string }> = [];
  (queue as { announce: typeof queue.announce }).announce = (async (text: string, kind?: string) => {
    calls.push({ text, kind: kind || 'dj-speak' });
  }) as typeof queue.announce;
  const app = express();
  app.use(express.json());
  app.use(djRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/dj/say`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: SAY_TEXT, mode: 'raw' }),
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [{ text: SAY_TEXT, kind: 'dj-speak' }]);
    return body;
  } finally {
    (queue as { announce: typeof queue.announce }).announce = original;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function failedPrimaryFallbackCalls(): Promise<SpeakCall[]> {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
      return;
    }
    if (req.url !== '/speak') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      writeFileSync(
        CALL_LOG,
        `${JSON.stringify({ engine: 'remote', text: body.text, outPath: FIXED_FALLBACK_OUT })}\n`,
        { flag: 'a' },
      );
      res.writeHead(503, { 'Content-Type': 'text/plain' }).end('compat failure');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const previous = settings.get();
  setCache({
    ...previous,
    tts: {
      ...previous.tts,
      defaultEngine: 'remote',
      remote: { ...previous.tts?.remote, url: `http://127.0.0.1:${port}` },
      fallback: { enabled: true, engine: 'piper', voice: '', cloudProvider: 'openai' },
    },
  });
  resetSpeakCalls();
  try {
    await remoteTts.refresh();
    const out = await tts.speak(SAY_TEXT, { kind: 'default', outPath: FIXED_FALLBACK_OUT });
    assert.equal(out, FIXED_FALLBACK_OUT);
    return readSpeakCalls();
  } finally {
    setCache(previous);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function talkTickSnapshot() {
  const state = { fired: {}, logged: {}, lastRoll: null };
  const dispatched: Array<{ kind: string; slot: string; claimed: string | null | undefined }> = [];
  const logs: Array<{ kind: string; message: string }> = [];
  const plans = await executeTalkTick({
    now: new Date('2026-01-15T12:15:00'),
    rollSession: async () => { throw new Error('unexpected roll'); },
    lastTalkBreakAt: () => 0,
    pendingTalk: () => null,
    eligible: () => true,
    externalSlot: () => null,
    betweenTracksOnly: () => false,
    plan: talkTickPlan,
    log: (kind, message) => logs.push({ kind, message }),
    runSlot: async (plan) => {
      dispatched.push({ kind: plan.kind, slot: plan.slot, claimed: state.fired[plan.kind] });
    },
  }, state);
  return {
    plans: JSON.parse(JSON.stringify(plans)),
    dispatched,
    logs,
    fired: state.fired,
    logged: state.logged,
  };
}

interface Received { event: string; body: Record<string, unknown> }

async function withHookServer(fn: (received: Received[]) => Promise<void>) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        received.push({ event: body.event, body });
      } catch { /* ignore */ }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const previous = settings.get();
  setCache({
    ...previous,
    stream: { ...(previous as { stream?: object }).stream, bufferSeconds: 22 },
    webhooks: [{
      id: 'compat_hook',
      url: `http://127.0.0.1:${port}/hook`,
      events: ['voice.queued', 'voice.start', 'voice.end'],
      enabled: true,
      authHeader: '',
    }],
  });
  try {
    await fn(received);
  } finally {
    setCache(previous);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function waitFor(received: Received[], event: string, timeoutMs = 3000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const hit = received.find((r) => r.event === event);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`no ${event} (saw: ${received.map((r) => r.event).join(', ') || 'nothing'})`);
}

async function voiceEventSnapshot() {
  let queued: Record<string, unknown> = {};
  let start: Record<string, unknown> = {};
  let end: Record<string, unknown> = {};
  await withHookServer(async (received) => {
    await withFixedDate(async () => {
      notifyQueued({
        voiceId: 'compat-voice',
        kind: 'dj-speak',
        channel: 'say',
        text: SAY_TEXT,
        durationMs: 20,
        estimatedAirInMs: 1050,
      });
      queued = (await waitFor(received, 'voice.queued')).body;
      notifySpoken({
        voiceId: 'compat-voice',
        kind: 'dj-speak',
        channel: 'say',
        text: SAY_TEXT,
        durationMs: 20,
        airedAt: FIXED_NOW,
      });
      start = (await waitFor(received, 'voice.start')).body;
      end = (await waitFor(received, 'voice.end')).body;
    });
  });
  return { queued, start, end };
}

async function snapshot(): Promise<CompatSnapshot> {
  resetSpeakCalls();
  const spoken = await tts.speak(SAY_TEXT, { kind: 'dj-speak', outPath: FIXED_OUT });
  const primaryCalls = readSpeakCalls();
  const faded = readFileSync(spoken);
  writeFileSync(join(STATE, 'voice', 'unfaded.wav'), pcmWav(16_000));
  await applyEdgeFades(join(STATE, 'voice', 'unfaded.wav'));
  const fadedAgain = readFileSync(join(STATE, 'voice', 'unfaded.wav'));
  const fallbackCalls = await failedPrimaryFallbackCalls();
  const queueJson = await persistedQueueSnapshot();
  const events = await voiceEventSnapshot();
  const sayBody = await saySuccessBody();
  return {
    primaryCalls,
    fallbackCalls,
    filename: spoken,
    sha256: sha256(faded),
    fadedSha256: sha256(fadedAgain),
    voiceUriZero: voiceUri(FIXED_OUT, 0, 'compat-voice'),
    voiceUriGain: voiceUri(FIXED_OUT, -3, 'compat-voice'),
    queueJson,
    sayBody,
    talkTick: await talkTickSnapshot(),
    voiceQueued: events.queued,
    voiceStart: events.start,
    voiceEnd: events.end,
  };
}

function assertDisabledIdentical(a: CompatSnapshot, b: CompatSnapshot, label: string) {
  assert.deepEqual(b.primaryCalls, a.primaryCalls, `${label}: primary speak calls`);
  assert.deepEqual(b.fallbackCalls, a.fallbackCalls, `${label}: fallback speak calls`);
  assert.equal(b.filename, a.filename, `${label}: filename`);
  assert.equal(b.sha256, a.sha256, `${label}: speak sha256`);
  assert.equal(b.fadedSha256, a.fadedSha256, `${label}: fade sha256`);
  assert.equal(b.voiceUriZero, a.voiceUriZero, `${label}: voiceUri 0 dB`);
  assert.equal(b.voiceUriGain, a.voiceUriGain, `${label}: voiceUri gain`);
  assert.deepEqual(b.queueJson, a.queueJson, `${label}: queue.json`);
  assert.deepEqual(b.sayBody, a.sayBody, `${label}: /dj/say`);
  assert.deepEqual(b.talkTick, a.talkTick, `${label}: talkTick`);
  assert.deepEqual(b.voiceQueued, a.voiceQueued, `${label}: voice.queued`);
  assert.deepEqual(b.voiceStart, a.voiceStart, `${label}: voice.start`);
  assert.deepEqual(b.voiceEnd, a.voiceEnd, `${label}: voice.end`);
}

test('disabled broadcast QA is identical when the setting is absent, malformed, or false', async () => {
  await coldLoad('absent');
  const absent = await snapshot();
  assert.deepEqual(absent, currentDevelopGolden(), 'absent setting matches the fixed current-develop golden');

  assert.deepEqual(
    absent.primaryCalls.map((c) => c.engine),
    ['piper'],
    'primary piper target is tried exactly once',
  );
  assert.equal(absent.primaryCalls[0].outPath, FIXED_OUT);
  assert.ok(absent.primaryCalls[0].text.includes(SAY_TEXT));
  assert.deepEqual(
    absent.fallbackCalls.map((c) => c.engine),
    ['remote', 'piper'],
    'a failing primary and successful fallback are each called exactly once, in order',
  );
  assert.equal(absent.filename, FIXED_OUT);
  assert.equal(absent.sha256, absent.fadedSha256, 'speak() applies the same 40 ms edge fade');
  assert.notEqual(absent.sha256, sha256(pcmWav(16_000)), 'fade mutates the constant-amplitude fixture');
  assert.equal(absent.voiceUriZero, `annotate:subwave_voice="compat-voice":${FIXED_OUT}`);
  assert.equal(absent.voiceUriGain, `annotate:liq_amplify="-3 dB",subwave_voice="compat-voice":${FIXED_OUT}`);
  assert.equal(
    JSON.stringify(absent.queueJson).includes('voiceRender'),
    false,
    'disabled queue.json must not grow a voiceRender key',
  );
  assert.deepEqual(absent.sayBody, {
    ok: true,
    mode: 'raw',
    kind: 'dj-speak',
    spoken: SAY_TEXT,
    sfx: null,
  });
  const tick = absent.talkTick as {
    dispatched: Array<{ kind: string; slot: string; claimed: string | null }>;
  };
  assert.deepEqual(tick.dispatched, [{
    kind: 'station-id',
    slot: '15',
    claimed: 'station-id-2026-1-15-12-15',
  }], 'the real scheduler executor claims then dispatches the :15 station ID');
  assert.equal(absent.voiceQueued.voiceId, 'compat-voice');
  assert.equal(absent.voiceQueued.estimated, true);
  assert.equal(absent.voiceStart.voiceId, 'compat-voice');
  assert.equal(absent.voiceStart.estimated, false);
  assert.equal(absent.voiceEnd.voiceId, 'compat-voice');
  assert.ok(!('text' in absent.voiceEnd), 'timer voice.end is a boundary');

  await coldLoad('malformed');
  assertDisabledIdentical(absent, await snapshot(), 'malformed');

  await coldLoad('false');
  assertDisabledIdentical(absent, await snapshot(), 'explicit false');
});

after(() => {
  rmSync(STATE, { recursive: true, force: true });
});
