// Cold-load and update contract for tts.broadcastQa.
//
// settings.load() composes the block field-by-field rather than spreading
// DEFAULTS, so a missing line still validates in-process and then vanishes on
// restart. These tests force a real re-read (setCache(null) + load()).
//
// Run: npx tsx scripts/voice-qa-settings.test.ts

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const stateRoot = mkdtempSync(join(tmpdir(), 'subwave-voice-qa-settings-'));
process.env.STATE_DIR = stateRoot;

const { setCache } = await import('../src/settings/store.js');
const settings = await import('../src/settings.js');
const { BROADCAST_QA_PROFILES } = await import('../src/schemas/voice.js');
const {
  BROADCAST_QA_REPLACEMENTS_LIMIT,
  BROADCAST_QA_RULES_LIMIT,
} = await import('../src/schemas/settings.js');
const { onBroadcastQaChange, resetBroadcastQaChangeForTests } = await import('../src/settings/change-events.js');
const { canonicalSha256 } = await import('../src/util/canonical-json.js');

const SETTINGS_PATH = join(stateRoot, 'settings.json');
const SCHEDULE_PATH = join(stateRoot, 'schedule.json');
const LIQ_JINGLE_RATIO_PATH = join(stateRoot, 'liquidsoap_jingle_ratio.txt');
const LIQ_JINGLE_RATIO_TARGET = join(stateRoot, 'jingle-ratio-target.txt');

const validPolicy = {
  enabled: true,
  replacements: [{
    id: 'brand-1',
    match: 'the station',
    replacement: 'Sundog Radio',
    caseSensitive: false,
    boundary: 'both',
  }],
  rules: [
    { id: 'ban-vibes', type: 'phrase', value: 'vibes' },
    { id: 'open-so', type: 'sentence-opener', value: 'So' },
    { id: 'line-hey', type: 'first-line-opener', value: 'Hey' },
    { id: 'folks-hour', type: 'station-hour-limit', value: 'folks', max: 1 },
  ],
  profiles: BROADCAST_QA_PROFILES,
};

async function coldLoad(tts: Record<string, unknown> | undefined) {
  writeFileSync(SETTINGS_PATH, JSON.stringify(tts ? { tts } : {}));
  setCache(null);
  await settings.load();
  return settings.get().tts.broadcastQa;
}

test('absent, false, malformed, and valid cold loads', async () => {
  const absent = await coldLoad({});
  assert.equal(absent.enabled, false);
  assert.deepEqual(absent.replacements, []);
  assert.deepEqual(absent.rules, []);
  assert.deepEqual(absent.profiles, BROADCAST_QA_PROFILES);

  const explicit = await coldLoad({ broadcastQa: { enabled: false, replacements: [], rules: [] } });
  assert.equal(explicit.enabled, false);
  assert.deepEqual(explicit.profiles, BROADCAST_QA_PROFILES);

  const malformed = await coldLoad({ broadcastQa: { enabled: 'yes', profiles: { talkup: { maxMs: 99_999 } } } });
  assert.equal(malformed.enabled, false);
  assert.deepEqual(malformed.replacements, []);
  assert.deepEqual(malformed.profiles, BROADCAST_QA_PROFILES);

  const valid = await coldLoad({ broadcastQa: validPolicy });
  assert.equal(valid.enabled, true);
  assert.equal(valid.replacements[0].match, 'the station');
  assert.equal(valid.rules.length, 4);
  assert.deepEqual(valid.profiles, BROADCAST_QA_PROFILES);
});

test('one malformed safety field fails the whole stored block closed', async () => {
  const variants = [
    {
      ...validPolicy,
      replacements: [{ ...validPolicy.replacements[0], match: '' }],
    },
    {
      ...validPolicy,
      replacements: [{ ...validPolicy.replacements[0], futureSafetyMode: 'allow' }],
    },
    {
      ...validPolicy,
      rules: [{ id: 'brand-1', type: 'phrase', value: 'duplicate across lists' }],
    },
    {
      ...validPolicy,
      profiles: { ...BROADCAST_QA_PROFILES, talkup: { ...BROADCAST_QA_PROFILES.talkup, maxMs: 99_999 } },
    },
  ];
  for (const broadcastQa of variants) {
    const loaded = await coldLoad({ broadcastQa });
    assert.deepEqual(loaded, {
      enabled: false,
      replacements: [],
      rules: [],
      profiles: BROADCAST_QA_PROFILES,
    });
  }
});

test('a broadcastQa save survives restart', async () => {
  await coldLoad({ broadcastQa: { enabled: false, replacements: [], rules: [] } });
  const result = await settings.update({ tts: { broadcastQa: validPolicy } });
  assert.equal(result.saved.tts.broadcastQa.enabled, true);
  setCache(null);
  await settings.load();
  assert.deepEqual(settings.get().tts.broadcastQa, validPolicy);
});

test('duplicate and invalid ids are refused on save', async () => {
  await coldLoad({});
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          enabled: true,
          replacements: [
            { id: 'dup', match: 'a', replacement: 'b', caseSensitive: false, boundary: 'none' },
            { id: 'dup', match: 'c', replacement: 'd', caseSensitive: false, boundary: 'none' },
          ],
          rules: [],
        },
      },
    }),
    /duplicated/,
  );
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          enabled: true,
          replacements: [],
          rules: [{ id: 'Nope', type: 'phrase', value: 'x' }],
        },
      },
    }),
    /id/,
  );
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          enabled: true,
          replacements: [
            { id: 'shared', match: 'a', replacement: 'b', caseSensitive: false, boundary: 'none' },
          ],
          rules: [{ id: 'shared', type: 'phrase', value: 'x' }],
        },
      },
    }),
    /duplicated/,
  );
});

test('unknown safety-shaped fields are refused on save', async () => {
  await coldLoad({});
  await assert.rejects(
    () => settings.update({
      tts: { broadcastQa: { ...validPolicy, bypassPolicy: true } },
    }),
    /unknown field "bypassPolicy"/,
  );
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          ...validPolicy,
          replacements: [{ ...validPolicy.replacements[0], bypassPolicy: true }],
        },
      },
    }),
    /unrecognized|unknown/i,
  );
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          ...validPolicy,
          rules: [{ ...validPolicy.rules[0], bypassPolicy: true }],
        },
      },
    }),
    /unrecognized|unknown/i,
  );
});

test('empty match strings and regex-shaped text stay literal', async () => {
  await coldLoad({});
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          enabled: true,
          replacements: [{ id: 'empty', match: '', replacement: 'x', caseSensitive: false, boundary: 'none' }],
          rules: [],
        },
      },
    }),
    /match/,
  );
  const saved = await settings.update({
    tts: {
      broadcastQa: {
        enabled: true,
        replacements: [{
          id: 'literal-re',
          match: '.*',
          replacement: '(foo|bar)',
          caseSensitive: false,
          boundary: 'none',
        }],
        rules: [{ id: 'literal-rule', type: 'phrase', value: 'a+' }],
      },
    },
  });
  assert.equal(saved.saved.tts.broadcastQa.replacements[0].match, '.*');
  assert.equal(saved.saved.tts.broadcastQa.replacements[0].replacement, '(foo|bar)');
  assert.equal(saved.saved.tts.broadcastQa.rules[0].value, 'a+');
});

test('array and string size bounds', async () => {
  await coldLoad({});
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          enabled: true,
          replacements: Array.from({ length: BROADCAST_QA_REPLACEMENTS_LIMIT + 1 }, (_, i) => ({
            id: `r${i}`,
            match: 'a',
            replacement: 'b',
            caseSensitive: false,
            boundary: 'none',
          })),
          rules: [],
        },
      },
    }),
    /at most/,
  );
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          enabled: true,
          replacements: [],
          rules: Array.from({ length: BROADCAST_QA_RULES_LIMIT + 1 }, (_, i) => ({
            id: `q${i}`,
            type: 'phrase',
            value: 'nope',
          })),
        },
      },
    }),
    /at most/,
  );
  await assert.rejects(
    () => settings.update({
      tts: {
        broadcastQa: {
          enabled: true,
          replacements: [{
            id: 'long',
            match: 'x'.repeat(81),
            replacement: 'y',
            caseSensitive: false,
            boundary: 'none',
          }],
          rules: [],
        },
      },
    }),
    /match|80/,
  );
});

test('the exact fixed profile map is accepted and every widened or weakened profile is rejected', async () => {
  await coldLoad({});
  const ok = await settings.update({
    tts: { broadcastQa: { enabled: false, replacements: [], rules: [], profiles: BROADCAST_QA_PROFILES } },
  });
  assert.deepEqual(ok.saved.tts.broadcastQa.profiles, BROADCAST_QA_PROFILES);

  for (const [name, bounds] of Object.entries(BROADCAST_QA_PROFILES)) {
    for (const field of ['minMs', 'maxMs', 'maxWords', 'maxSentences'] as const) {
      const widened = structuredClone(BROADCAST_QA_PROFILES);
      (widened[name as keyof typeof widened] as Record<string, number>)[field] = bounds[field] + 1;
      await assert.rejects(
        () => settings.update({
          tts: { broadcastQa: { enabled: false, replacements: [], rules: [], profiles: widened } },
        }),
        /fixed duration map/,
        `accepted widened ${name}.${field}`,
      );
      const weakened = structuredClone(BROADCAST_QA_PROFILES);
      (weakened[name as keyof typeof weakened] as Record<string, number>)[field] = Math.max(0, bounds[field] - 1);
      if (weakened[name as keyof typeof weakened][field] === bounds[field]) continue;
      await assert.rejects(
        () => settings.update({
          tts: { broadcastQa: { enabled: false, replacements: [], rules: [], profiles: weakened } },
        }),
        /fixed duration map/,
        `accepted weakened ${name}.${field}`,
      );
    }
  }
});

test('a broadcastQa patch leaves unrelated TTS fields alone', async () => {
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    tts: {
      defaultEngine: 'kokoro',
      corrections: [{ from: 'GHz', to: 'gigahertz' }],
      cloud: { enabled: true, provider: 'openai', voice: 'alloy', model: 'gpt-4o-mini-tts' },
      gainDb: { piper: 2 },
    },
  }));
  setCache(null);
  await settings.load();
  const before = settings.get().tts;
  await settings.update({ tts: { broadcastQa: validPolicy } });
  const after = settings.get().tts;
  assert.equal(after.defaultEngine, before.defaultEngine);
  assert.deepEqual(after.corrections, before.corrections);
  assert.equal(after.cloud.voice, before.cloud.voice);
  assert.equal(after.gainDb.piper, before.gainDb.piper);
  assert.equal(after.broadcastQa.enabled, true);
});

test('canonical hashes are order-independent for objects', () => {
  assert.equal(
    canonicalSha256({ b: 1, a: 2 }),
    canonicalSha256({ a: 2, b: 1 }),
  );
  assert.notEqual(
    canonicalSha256(['a', 'b']),
    canonicalSha256(['b', 'a']),
  );
  assert.throws(() => canonicalSha256({ when: new Date() }));
  const hostile = JSON.parse('{"__proto__":{"enabled":true}}');
  assert.notEqual(canonicalSha256(hostile), canonicalSha256({}));
  assert.throws(() => canonicalSha256(Array(1)), /sparse/);
  assert.throws(() => canonicalSha256([undefined]), /non-JSON/);
  const arrayWithProperty = [null] as unknown[] & { extra?: string };
  arrayWithProperty.extra = 'ignored by JSON.stringify';
  assert.throws(() => canonicalSha256(arrayWithProperty), /array/);
});

test('the fixed profiles stay deeply immutable through load and unrelated saves', async () => {
  const loaded = await coldLoad({ broadcastQa: validPolicy });
  assert.equal(loaded.profiles, BROADCAST_QA_PROFILES);
  assert.equal(Object.isFrozen(BROADCAST_QA_PROFILES), true);
  assert.equal(Object.isFrozen(BROADCAST_QA_PROFILES.talkup), true);
  assert.throws(() => {
    (loaded.profiles.talkup as { maxMs: number }).maxMs = 99_999;
  }, TypeError);
  await settings.update({ stationDescription: 'immutability check' });
  const after = settings.get().tts.broadcastQa;
  assert.equal(after.profiles, BROADCAST_QA_PROFILES);
  assert.equal(after.profiles.talkup.maxMs, 12_000);
  assert.equal(Object.isFrozen(after.profiles.talkup), true);
});

test('a persistence failure leaves the QA cache and subscribers unchanged', async () => {
  await coldLoad({ broadcastQa: { enabled: false, replacements: [], rules: [] } });
  resetBroadcastQaChangeForTests();
  const seen: boolean[] = [];
  const stop = onBroadcastQaChange((qa) => { seen.push(qa.enabled); });
  const scheduleBefore = '{"schedule":"before"}';
  const liquidsoapBefore = 'ratio-before';
  writeFileSync(SCHEDULE_PATH, scheduleBefore);
  writeFileSync(LIQ_JINGLE_RATIO_PATH, liquidsoapBefore);
  rmSync(SETTINGS_PATH, { force: true });
  mkdirSync(SETTINGS_PATH);
  try {
    await assert.rejects(
      () => settings.update({
        jingleRatio: 0.77,
        tts: { broadcastQa: validPolicy },
      }),
    );
    assert.equal(settings.get().tts.broadcastQa.enabled, false);
    assert.deepEqual(seen, []);
    assert.equal(readFileSync(SCHEDULE_PATH, 'utf8'), scheduleBefore);
    assert.equal(readFileSync(LIQ_JINGLE_RATIO_PATH, 'utf8'), liquidsoapBefore);
  } finally {
    stop();
    rmSync(SETTINGS_PATH, { recursive: true, force: true });
    rmSync(SCHEDULE_PATH, { force: true });
    rmSync(LIQ_JINGLE_RATIO_PATH, { force: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      tts: { broadcastQa: { enabled: false, replacements: [], rules: [] } },
    }));
  }
});

test('auxiliary write failures cannot persist a rejected QA policy', async () => {
  for (const blockedPath of [SCHEDULE_PATH, LIQ_JINGLE_RATIO_PATH]) {
    await coldLoad({ broadcastQa: { enabled: false, replacements: [], rules: [] } });
    resetBroadcastQaChangeForTests();
    const seen: boolean[] = [];
    const stop = onBroadcastQaChange((qa) => { seen.push(qa.enabled); });
    rmSync(blockedPath, { recursive: true, force: true });
    mkdirSync(blockedPath);
    try {
      await assert.rejects(
        () => settings.update({ tts: { broadcastQa: validPolicy } }),
      );
      assert.equal(settings.get().tts.broadcastQa.enabled, false);
      assert.deepEqual(seen, []);
      const disk = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
      assert.equal(disk.tts.broadcastQa.enabled, false);
    } finally {
      stop();
      rmSync(blockedPath, { recursive: true, force: true });
    }
    setCache(null);
    await settings.load();
    assert.equal(
      settings.get().tts.broadcastQa.enabled,
      false,
      `rejected policy must stay disabled after restart when ${blockedPath} fails`,
    );
  }
});

test('rollback restores a symlink-backed Liquidsoap handoff target', async () => {
  await coldLoad({ broadcastQa: { enabled: false, replacements: [], rules: [] } });
  writeFileSync(LIQ_JINGLE_RATIO_TARGET, 'ratio-before');
  rmSync(LIQ_JINGLE_RATIO_PATH, { recursive: true, force: true });
  symlinkSync(LIQ_JINGLE_RATIO_TARGET, LIQ_JINGLE_RATIO_PATH);
  rmSync(SETTINGS_PATH, { force: true });
  mkdirSync(SETTINGS_PATH);
  try {
    await assert.rejects(
      () => settings.update({
        jingleRatio: 0.77,
        tts: { broadcastQa: validPolicy },
      }),
    );
    assert.equal(readFileSync(LIQ_JINGLE_RATIO_TARGET, 'utf8'), 'ratio-before');
    assert.equal(settings.get().tts.broadcastQa.enabled, false);
  } finally {
    rmSync(SETTINGS_PATH, { recursive: true, force: true });
    rmSync(LIQ_JINGLE_RATIO_PATH, { force: true });
    rmSync(LIQ_JINGLE_RATIO_TARGET, { force: true });
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      tts: { broadcastQa: { enabled: false, replacements: [], rules: [] } },
    }));
  }
});

test('concurrent settings saves commit in call order', async () => {
  await coldLoad({ broadcastQa: { enabled: false, replacements: [], rules: [] } });
  await Promise.all([
    settings.update({
      stationDescription: 'first save',
      tts: { broadcastQa: validPolicy },
    }),
    settings.update({
      stationDescription: 'second save',
      tts: { broadcastQa: { enabled: false, replacements: [], rules: [] } },
    }),
  ]);
  assert.equal(settings.get().stationDescription, 'second save');
  assert.equal(settings.get().tts.broadcastQa.enabled, false);
  const disk = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
  assert.equal(disk.stationDescription, 'second save');
  assert.equal(disk.tts.broadcastQa.enabled, false);
});

test('broadcastQa change events fire only when the effective block changes', async () => {
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    tts: { broadcastQa: { enabled: false, replacements: [], rules: [] } },
  }));
  setCache(null);
  resetBroadcastQaChangeForTests();
  const seen: boolean[] = [];
  const stop = onBroadcastQaChange((qa) => { seen.push(qa.enabled); });
  await settings.load();
  assert.deepEqual(seen, [false]);
  await settings.update({ tts: { broadcastQa: { enabled: false, replacements: [], rules: [] } } });
  assert.deepEqual(seen, [false], 'identical update is silent');
  await settings.update({ tts: { broadcastQa: validPolicy } });
  assert.deepEqual(seen, [false, true]);
  stop();
});
