// Pre-TTS text policy: replacements, openers, rolling read-only, one rewrite,
// source-backed lockout, and track-link announce/natural rules.
// Run: npx tsx scripts/voice-text-policy.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-voice-text-policy-'));

const { BROADCAST_QA_PROFILES } = await import('../src/schemas/voice.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');
const {
  applyReplacements,
  buildTrackLinkContext,
  findLiteralMatches,
  openerHits,
  runTextPolicy,
  splitSentences,
} = await import('../src/audio/voice-qa/text-policy.js');
const { tokenizeFactLocks } = await import('../src/audio/voice-qa/fact-locks.js');
const { VOICE_REWRITE_MAX_OUTPUT_TOKENS, VOICE_REWRITE_KIND } = await import('../src/audio/voice-qa/rewrite.js');

function policy(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    replacements: [],
    rules: [],
    profiles: BROADCAST_QA_PROFILES,
    ...overrides,
  };
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    policy: policy(),
    corrections: [],
    nowMs: Date.parse('2026-09-05T19:00:00.000Z'),
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
    rolling: { history: [], reservations: [] },
    rewriteFn: async () => {
      throw new Error('rewrite should not run');
    },
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    auditId: 'qa-1',
    displayText: 'Clear skies over town.',
    kind: 'link',
    profile: 'bedded-link',
    automatic: true,
    rewriteAllowed: false,
    rewriteCount: 0,
    legacyGainDb: 0,
    facts: { sourceBacked: false, factLocks: [] },
    ...overrides,
  };
}

function lease(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    skillId: 'weather-ec',
    sourceId: 'ec-citypage',
    sourceRef: 'citypage:melita',
    attribution: 'Environment Canada',
    fetchedAt: '2026-09-05T18:00:00.000Z',
    expiresAt: '2026-09-06T18:00:00.000Z',
    entityKey: 'melita',
    sourceRevision: 'r1',
    payloadHash: 'p1',
    candidateRevision: 'c1',
    revalidationKey: 'k1',
    ...overrides,
  };
}

const speakerA = {
  id: 'nova',
  name: 'Nova',
  language: 'English',
  linkStyle: 'announce',
  tts: { engine: 'kokoro', voice: 'bf_isabella' },
};
const speakerB = {
  id: 'reed',
  name: 'Reed',
  language: 'English',
  linkStyle: 'announce',
  tts: { engine: 'kokoro', voice: 'am_michael' },
};
const naturalSpeaker = { ...speakerA, linkStyle: 'natural' };

test('So comma, SO dash, and so ellipsis hit the same sentence opener', () => {
  for (const line of ['So, the wind is up.', 'SO — the wind is up.', 'so ... the wind is up.']) {
    const sentence = splitSentences(line)[0];
    assert.equal(openerHits(sentence.text, 'So'), true, line);
  }
  assert.equal(openerHits('Some wind is up.', 'So'), false);
});

test('sentence openers are found after closing and opening quotation marks', () => {
  const sentences = splitSentences('Fine.” “So, here we are.”');
  assert.equal(sentences.length, 2);
  assert.equal(openerHits(sentences[1].text, 'So'), true);
});

test('quoted sentence openers are rejected by the full policy path', async () => {
  const result = await runTextPolicy(request({
    displayText: 'Fine.” “So, here we are.”',
  }), ctx({
    policy: policy({
      rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
    }),
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.failedRuleIds.includes('open-so'));
});

test('Unicode normalization and UTF-16 source spans stay aligned', () => {
  const decomposed = 'Try cafe\u0301 tonight.';
  const café = findLiteralMatches(decomposed, 'café', {
    caseSensitive: false,
    boundary: 'both',
  });
  assert.equal(café.length, 1);
  assert.equal(café[0].text, 'cafe\u0301');
  assert.equal(café[0].end - café[0].start, 'cafe\u0301'.length);

  const afterEmoji = '🙂 Visit the station.';
  const phrase = findLiteralMatches(afterEmoji, 'the station', {
    caseSensitive: false,
    boundary: 'both',
  })[0];
  assert.equal(phrase.start, '🙂 Visit '.length);
  assert.equal(phrase.end, '🙂 Visit the station'.length);

  const astral = applyReplacements('A 𐐀 marker.', [{
    id: 'astral',
    match: '𐐀',
    replacement: 'X',
    caseSensitive: true,
    boundary: 'both',
  }]);
  assert.equal(astral.text, 'A X marker.');
  assert.deepEqual(
    { start: astral.records[0].sourceStart, end: astral.records[0].sourceEnd },
    { start: 2, end: 4 },
  );

  assert.equal(findLiteralMatches('ß', 's', {
    caseSensitive: false,
    boundary: 'none',
  }).length, 0);
  const expandedFold = applyReplacements('ß', [{
    id: 'fold-expansion',
    match: 'ss',
    replacement: 'XYZ',
    caseSensitive: false,
    boundary: 'none',
  }]);
  assert.equal(expandedFold.text, 'XYZ');
  assert.equal(expandedFold.records.length, 1);

  const punctuationOnly = applyReplacements('ß.', [{
    id: 'punctuation-only',
    match: '.',
    replacement: '!',
    caseSensitive: false,
    boundary: 'none',
  }]);
  assert.equal(punctuationOnly.text, 'ß!');
  assert.deepEqual(
    {
      start: punctuationOnly.records[0].sourceStart,
      end: punctuationOnly.records[0].sourceEnd,
      text: punctuationOnly.records[0].matchedText,
    },
    { start: 1, end: 2, text: '.' },
  );
  assert.equal(findLiteralMatches('Diyarbakır', 'Diyarbakir', {
    caseSensitive: false,
    boundary: 'both',
  }).length, 0);
  assert.deepEqual(findLiteralMatches('J\u030C', 'ǰ', {
    caseSensitive: false,
    boundary: 'both',
  })[0], { start: 0, end: 2, text: 'J\u030C' });
});

test('replacements run once each in stored order and keep source spans', () => {
  const { text, records } = applyReplacements('Visit the station, then the station again.', [
    {
      id: 'brand-1',
      match: 'the station',
      replacement: 'this radio',
      caseSensitive: false,
      boundary: 'both',
    },
    {
      id: 'brand-2',
      match: 'this radio',
      replacement: 'Sundog Radio',
      caseSensitive: false,
      boundary: 'both',
    },
  ]);
  assert.equal(text, 'Visit Sundog Radio, then Sundog Radio again.');
  assert.equal(records.length, 4);
  assert.equal(records[0].step, 1);
  assert.equal(records[0].sourceStart, 6);
  assert.equal(records[0].matchedText, 'the station');
  assert.equal(findLiteralMatches('use .* as text', '.*', {
    caseSensitive: true,
    boundary: 'none',
  })[0]?.text, '.*');
});

test('a fact lock cannot be satisfied inside a larger word', async () => {
  const result = await runTextPolicy(request({
    displayText: 'Melitaville is clear.',
    facts: {
      sourceBacked: false,
      factLocks: [{ id: 'place.town', displayValue: 'Melita', required: true }],
    },
  }), ctx());
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.failedRuleIds.includes('fact-cardinality'));
});

test('stripThinking and display normalize run before replacements', async () => {
  const result = await runTextPolicy(request({
    displayText: '<think>secret</think>Visit **the station**.',
  }), ctx({
    policy: policy({
      replacements: [{
        id: 'brand-1',
        match: 'the station',
        replacement: 'Sundog Radio',
        caseSensitive: false,
        boundary: 'both',
      }],
    }),
  }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.displayText, 'Visit Sundog Radio.');
    assert.equal(result.replacements[0].matchedText, 'the station');
  }
});

test('presentation labels and stage directions never reach speech', async () => {
  const cases = [
    {
      displayText: '[speaking in a deliberately slow and serious radio voice]',
      failedRuleId: 'stage-direction',
    },
    {
      displayText: 'Voice Direction: Speak plainly.',
      failedRuleId: 'label',
    },
    {
      displayText: '> Speak plainly.',
      failedRuleId: 'markdown',
    },
    {
      displayText: '>Speak plainly.',
      failedRuleId: 'markdown',
    },
    {
      displayText: '>> Speak plainly.',
      failedRuleId: 'markdown',
    },
    {
      displayText: '◦ Speak plainly.',
      failedRuleId: 'markdown',
    },
    {
      displayText: '⁃ Speak plainly.',
      failedRuleId: 'markdown',
    },
    {
      displayText: '∙ Speak plainly.',
      failedRuleId: 'markdown',
    },
    {
      displayText: '● Speak plainly.',
      failedRuleId: 'markdown',
    },
    {
      displayText: 'Weather:Clear skies.',
      failedRuleId: 'label',
    },
    {
      displayText: 'Road 511:Clear.',
      failedRuleId: 'label',
    },
    {
      displayText: '<voice>Speak plainly.</voice>',
      failedRuleId: 'markdown',
    },
  ];
  for (const { displayText, failedRuleId } of cases) {
    const result = await runTextPolicy(request({ displayText }), ctx());
    assert.equal(result.ok, false, displayText);
    if (!result.ok) assert.ok(result.failedRuleIds.includes(failedRuleId), displayText);

    const sourceResult = await runTextPolicy(request({
      displayText,
      facts: {
        sourceBacked: true,
        factLocks: [{
          id: 'copy.full',
          displayValue: displayText,
          required: true,
          sourceRef: 'citypage:melita',
          sourceRevision: 'r1',
        }],
        provenance: lease(),
      },
    }), ctx());
    assert.equal(sourceResult.ok, false, `locked: ${displayText}`);
    if (!sourceResult.ok) {
      assert.ok(sourceResult.failedRuleIds.includes(failedRuleId), `locked: ${displayText}`);
    }
  }

  const hidden = '[speaking slowly] Clear skies.';
  const hiddenResult = await runTextPolicy(request({
    displayText: hidden,
    facts: {
      sourceBacked: true,
      factLocks: [
        {
          id: 'copy.full',
          displayValue: hidden,
          required: true,
          sourceRef: 'citypage:melita',
          sourceRevision: 'r1',
        },
        {
          id: 'direction.optional',
          displayValue: '[speaking slowly]',
          required: false,
          sourceRef: 'citypage:melita',
          sourceRevision: 'r1',
        },
      ],
      provenance: lease(),
    },
  }), ctx());
  assert.equal(hiddenResult.ok, false);
  if (!hiddenResult.ok) assert.ok(hiddenResult.failedRuleIds.includes('stage-direction'));
});

test('rolling hour limits are read-only and do not consume allowance', async () => {
  const history = [{
    ruleId: 'folks-hour',
    value: 'folks',
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
  }];
  const rollingCtx = ctx({
    policy: policy({
      rules: [{ id: 'folks-hour', type: 'station-hour-limit', value: 'folks', max: 1 }],
    }),
    rolling: { history, reservations: [] },
  });
  const blocked = await runTextPolicy(request({ displayText: 'Hang on, folks.' }), rollingCtx);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.failedRuleIds.includes('folks-hour'));
  assert.equal(history.length, 1);

  const allowed = await runTextPolicy(request({ displayText: 'Hang on a minute.' }), rollingCtx);
  assert.equal(allowed.ok, true);
  assert.equal(history.length, 1);
});

test('rolling limits key prior occurrences by both rule id and value', async () => {
  const result = await runTextPolicy(request({ displayText: 'Hang on, neighbours.' }), ctx({
    policy: policy({
      rules: [{ id: 'address-hour', type: 'station-hour-limit', value: 'neighbours', max: 1 }],
    }),
    rolling: {
      history: [{
        ruleId: 'address-hour',
        value: 'folks',
        stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
      }],
      reservations: [],
    },
  }));
  assert.equal(result.ok, true);
});

test('one rewrite is allowed; a still-invalid answer is terminal', async () => {
  const calls: string[] = [];
  const result = await runTextPolicy(request({
    displayText: 'So, here we go with the vibes.',
    rewriteAllowed: true,
  }), ctx({
    policy: policy({
      rules: [
        { id: 'open-so', type: 'sentence-opener', value: 'So' },
        { id: 'ban-vibes', type: 'phrase', value: 'vibes' },
      ],
    }),
    rewriteFn: async ({ prompt, maxOutputTokens, kind }) => {
      calls.push(prompt);
      assert.equal(maxOutputTokens, VOICE_REWRITE_MAX_OUTPUT_TOKENS);
      assert.equal(kind, VOICE_REWRITE_KIND);
      return 'So, still the vibes.';
    },
  }));
  assert.equal(calls.length, 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.stage, 'rewrite');
    assert.ok(result.failedRuleIds.includes('open-so'));
  }
});

test('a valid rewrite restores tokens and does not call the model again', async () => {
  const locks = [{ id: 'place.town', displayValue: 'Melita', required: true }];
  const tokenized = tokenizeFactLocks('So, warm air over Melita.', locks);
  assert.equal('tokens' in tokenized, true);
  if (!('tokens' in tokenized)) return;
  let calls = 0;
  const result = await runTextPolicy(request({
    displayText: 'So, warm air over Melita.',
    rewriteAllowed: true,
    facts: { sourceBacked: false, factLocks: locks },
  }), ctx({
    policy: policy({
      rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
    }),
    rewriteFn: async ({ prompt }) => {
      calls += 1;
      assert.match(prompt, /open-so/);
      assert.match(prompt, /\[\[FACT_0_/);
      return `Warm air over ${tokenized.tokens[0].token}.`;
    },
  }));
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.displayText, 'Warm air over Melita.');
    assert.equal(result.rewriteCount, 1);
    assert.match(result.spokenText, /Melita/);
  }
});

test('a rewrite cannot add any unsupported factual signature', async () => {
  const invented = [
    'Plain words with 8.',
    'Plain words with eight.',
    'Plain words in May.',
    'Plain words in may.',
    'Plain words at eight p.m.',
    'Plain words across ten kilometres.',
    'Plain words northwest.',
    'Details at example.ca.',
    'According to CBC, plain words.',
    'The album has plain words.',
    'Plain words in Montréal.',
    'Winnipeg feels quiet.',
    'winnipeg feels quiet.',
    'montréal feels quiet.',
    'Plain words for winnipeg.',
    'Plain words in september near winnipeg.',
    'Fine.” “winnipeg feels quiet.”',
    'Listen at sundog.fm.',
  ];
  for (const rewritten of invented) {
    const result = await runTextPolicy(request({
      displayText: 'So, plain words.',
      rewriteAllowed: true,
    }), ctx({
      policy: policy({
        rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
      }),
      rewriteFn: async () => rewritten,
    }));
    assert.equal(result.ok, false, rewritten);
    if (!result.ok) {
      assert.equal(result.stage, 'rewrite', rewritten);
      assert.ok(result.failedRuleIds.includes('new-facts'), rewritten);
    }
  }
});

test('a rewrite cannot repurpose existing numbers into new dates or times', async () => {
  const cases = [
    {
      before: 'So, eight people sat at eight chairs.',
      after: 'Eight people are coming at eight tonight.',
    },
    {
      before: 'So, five plain words.',
      after: 'Plain words on may five.',
    },
    {
      before: 'So, next plain week.',
      after: 'Next week.',
    },
    {
      before: 'So, eight people took thirty chairs.',
      after: 'Eight thirty.',
    },
    {
      before: 'So, 2026, 09, and 05.',
      after: '2026-09-05.',
    },
    {
      before: 'So, 8 and 30.',
      after: '8:30.',
    },
    {
      before: 'So, ten people walked past eight chairs.',
      after: 'Ten past eight.',
    },
    {
      before: 'So, next is a word and Monday is another.',
      after: 'Next Monday.',
    },
    {
      before: 'So, September is a word and five is another.',
      after: 'September five.',
    },
    {
      before: 'So, next is a word and morning is another.',
      after: 'Next morning.',
    },
    {
      before: 'So, last is a word and night is another.',
      after: 'Last night.',
    },
    {
      before: 'So, right and now are plain words.',
      after: 'Right now.',
    },
    {
      before: 'So, in and an and hour are plain words.',
      after: 'In an hour.',
    },
    {
      before: 'So, northerly is one word and wind is another.',
      after: 'Northerly wind.',
    },
    {
      before: 'So, several, hectares, and burned are separate words.',
      after: 'Several hectares burned.',
    },
  ];
  for (const { before, after } of cases) {
    const result = await runTextPolicy(request({
      displayText: before,
      rewriteAllowed: true,
    }), ctx({
      policy: policy({
        rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
      }),
      rewriteFn: async () => after,
    }));
    assert.equal(result.ok, false, after);
    if (!result.ok) {
      assert.equal(result.stage, 'rewrite', after);
      assert.ok(result.failedRuleIds.includes('new-facts'), after);
    }
  }
});

test('a rewrite cannot change relationships between locked facts', async () => {
  const locks = [
    { id: 'place.first', displayValue: 'Melita', required: true },
    { id: 'place.second', displayValue: 'Waskada', required: true },
  ];
  const cases = [
    {
      before: 'So, Melita before Waskada.',
      connector: 'after',
    },
    {
      before: 'So, Melita is north of Waskada, and not affected.',
      connector: 'is not north of',
    },
  ];
  for (const { before, connector } of cases) {
    const tokenized = tokenizeFactLocks(before, locks);
    if (!('tokens' in tokenized)) throw new Error(tokenized.message);
    const byId = new Map(tokenized.tokens.map((token) => [token.lock.id, token.token]));
    const result = await runTextPolicy(request({
      displayText: before,
      rewriteAllowed: true,
      facts: { sourceBacked: false, factLocks: locks },
    }), ctx({
      policy: policy({
        rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
      }),
      rewriteFn: async () => (
        `${byId.get('place.first')} ${connector} ${byId.get('place.second')}.`
      ),
    }));
    assert.equal(result.ok, false, connector);
  }
});

test('rewrites only remove approved non-semantic openers and never reorder words', async () => {
  const reordered = await runTextPolicy(request({
    displayText: 'So, Roads are open, not closed.',
    rewriteAllowed: true,
  }), ctx({
    policy: policy({
      rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
    }),
    rewriteFn: async () => 'Roads are closed, not open.',
  }));
  assert.equal(reordered.ok, false);

  const changedQuestion = await runTextPolicy(request({
    displayText: 'So, roads are open?',
    rewriteAllowed: true,
  }), ctx({
    policy: policy({
      rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
    }),
    rewriteFn: async () => 'Roads are open.',
  }));
  assert.equal(changedQuestion.ok, false);

  const droppedMinus = await runTextPolicy(request({
    displayText: 'So, -5 degrees.',
    rewriteAllowed: true,
  }), ctx({
    policy: policy({
      rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
    }),
    rewriteFn: async () => '5 degrees.',
  }));
  assert.equal(droppedMinus.ok, false);

  const splitCompound = await runTextPolicy(request({
    displayText: 'Well-being is useful.',
    rewriteAllowed: true,
  }), ctx({
    policy: policy({
      rules: [{ id: 'open-well', type: 'sentence-opener', value: 'Well' }],
    }),
    rewriteFn: async () => 'Being is useful.',
  }));
  assert.equal(splitCompound.ok, false);

  for (const [before, after] of [
    ['“So, roads are open.”', 'Roads are open.”'],
    ['(So, roads are open.)', 'Roads are open.)'],
  ]) {
    const droppedOpeningWrapper = await runTextPolicy(request({
      displayText: before,
      rewriteAllowed: true,
    }), ctx({
      policy: policy({
        rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
      }),
      rewriteFn: async () => after,
    }));
    assert.equal(droppedOpeningWrapper.ok, false, before);
  }

  const preservedWrapper = await runTextPolicy(request({
    displayText: '“So, 5 degrees.”',
    rewriteAllowed: true,
  }), ctx({
    policy: policy({
      rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
    }),
    rewriteFn: async () => '“5 degrees.”',
  }));
  assert.equal(preservedWrapper.ok, true);

  const locks = [
    { id: 'place.first', displayValue: 'Melita', required: true },
    { id: 'place.second', displayValue: 'Waskada', required: true },
  ];
  for (const opener of ['Maybe', 'North of', 'Beyond', 'Hardly']) {
    const before = `${opener} Melita is north of Waskada.`;
    const tokenized = tokenizeFactLocks(before, locks);
    if (!('tokens' in tokenized)) throw new Error(tokenized.message);
    const byId = new Map(tokenized.tokens.map((token) => [token.lock.id, token.token]));
    const result = await runTextPolicy(request({
      displayText: before,
      rewriteAllowed: true,
      facts: { sourceBacked: false, factLocks: locks },
    }), ctx({
      policy: policy({
        rules: [{ id: 'semantic-opener', type: 'sentence-opener', value: opener }],
      }),
      rewriteFn: async () => (
        `${byId.get('place.first')} is north of ${byId.get('place.second')}.`
      ),
    }));
    assert.equal(result.ok, false, opener);
  }
});

test('an existing rewrite count is preserved and forbids another model call', async () => {
  let calls = 0;
  const result = await runTextPolicy(request({
    displayText: 'Plain words.',
    rewriteAllowed: true,
    rewriteCount: 1,
  }), ctx({
    rewriteFn: async () => {
      calls += 1;
      return 'should not run';
    },
  }));
  assert.equal(calls, 0);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.rewriteCount, 1);
});

test('source-backed requests never enter the LLM rewrite path', async () => {
  let calls = 0;
  const result = await runTextPolicy(request({
    displayText: 'So, minus eighteen in Melita.',
    rewriteAllowed: true,
    facts: {
      sourceBacked: true,
      factLocks: [{
        id: 'copy.full',
        displayValue: 'So, minus eighteen in Melita.',
        required: true,
        sourceRef: 'citypage:melita',
        sourceRevision: 'r1',
      }],
      provenance: {
        schemaVersion: 1,
        skillId: 'weather-ec',
        sourceId: 'ec-citypage',
        sourceRef: 'citypage:melita',
        attribution: 'Environment Canada',
        fetchedAt: '2026-09-05T18:00:00.000Z',
        expiresAt: '2026-09-06T18:00:00.000Z',
        entityKey: 'melita',
        sourceRevision: 'r1',
        payloadHash: 'p1',
        candidateRevision: 'c1',
        revalidationKey: 'k1',
      },
    },
  }), ctx({
    policy: policy({
      rules: [{ id: 'open-so', type: 'sentence-opener', value: 'So' }],
    }),
    rewriteFn: async () => {
      calls += 1;
      return 'nope';
    },
  }));
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.stage, 'text-policy');
});

test('source-backed locks are runtime-parsed and bound to the lease', async () => {
  const good = await runTextPolicy(request({
    displayText: 'An update for Melita.',
    facts: {
      sourceBacked: true,
      factLocks: [{
        id: 'copy.full',
        displayValue: 'An update for Melita.',
        required: true,
        sourceRef: 'citypage:melita',
        sourceRevision: 'r1',
      }],
      provenance: lease(),
    },
  }), ctx());
  assert.equal(good.ok, true);

  const noLocks = await runTextPolicy(request({
    facts: { sourceBacked: true, factLocks: [], provenance: lease() },
  }), ctx());
  assert.equal(noLocks.ok, false);
  if (!noLocks.ok) assert.ok(noLocks.failedRuleIds.includes('provenance'));

  const mismatch = await runTextPolicy(request({
    displayText: 'An update for Melita.',
    facts: {
      sourceBacked: true,
      factLocks: [{
        id: 'place.town',
        displayValue: 'Melita',
        required: true,
        sourceRef: 'citypage:other',
        sourceRevision: 'r2',
      }],
      provenance: lease(),
    },
  }), ctx());
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) assert.ok(mismatch.failedRuleIds.includes('provenance'));

  const malformed = await runTextPolicy(request({
    facts: {
      sourceBacked: true,
      factLocks: [{
        id: 'place.town',
        displayValue: 'Melita',
        required: true,
        sourceRef: 'citypage:melita',
        sourceRevision: 'r1',
        unverified: true,
      }],
      provenance: lease(),
    },
  }), ctx());
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.ok(malformed.failedRuleIds.includes('fact-shape'));

  const optionalOnly = await runTextPolicy(request({
    displayText: 'Roads are clear.',
    facts: {
      sourceBacked: true,
      factLocks: [{
        id: 'road.closed',
        displayValue: 'closed',
        required: false,
        sourceRef: 'citypage:melita',
        sourceRevision: 'r1',
      }],
      provenance: lease(),
    },
  }), ctx());
  assert.equal(optionalOnly.ok, false);
  if (!optionalOnly.ok) assert.ok(optionalOnly.failedRuleIds.includes('provenance'));

  const futureFetched = await runTextPolicy(request({
    displayText: 'An update for Melita.',
    facts: {
      sourceBacked: true,
      factLocks: [{
        id: 'place.town',
        displayValue: 'Melita',
        required: true,
        sourceRef: 'citypage:melita',
        sourceRevision: 'r1',
      }],
      provenance: lease({
        fetchedAt: '2026-09-05T20:00:00.000Z',
        expiresAt: '2026-09-05T21:00:00.000Z',
      }),
    },
  }), ctx());
  assert.equal(futureFetched.ok, false);
  if (!futureFetched.ok) assert.ok(futureFetched.failedRuleIds.includes('provenance'));
});

test('expired provenance is source_stale', async () => {
  const result = await runTextPolicy(request({
    facts: {
      sourceBacked: true,
      factLocks: [],
      provenance: {
        schemaVersion: 1,
        skillId: 'weather-ec',
        sourceId: 'ec-citypage',
        sourceRef: 'citypage:melita',
        attribution: 'Environment Canada',
        fetchedAt: '2026-09-05T16:00:00.000Z',
        expiresAt: '2026-09-05T18:00:00.000Z',
        entityKey: 'melita',
        sourceRevision: 'r1',
        payloadHash: 'p1',
        candidateRevision: 'c1',
        revalidationKey: 'k1',
      },
    },
  }), ctx());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'source_stale');
});

test('current-track announce stays This is and does not follow last aired', () => {
  const built = buildTrackLinkContext({
    speakerPersona: speakerA,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: true,
    lastAiredLink: 'This is Joni Mitchell.',
  });
  assert.equal('ok' in built && built.ok === false, false);
  if ('ok' in built) return;
  assert.equal(built.context.style, 'announce');
  assert.equal(built.displayText, 'This is Neil Young.');
  if (built.context.style === 'announce') {
    assert.equal(built.context.announceForm, 'this-is');
  }
  assert.equal(built.rewriteAllowed, false);
  assert.equal(built.factLocks.find((lock) => lock.id === 'track.title')?.required, false);
});

test('announce alternation uses the last aired link, not a dropped compose', () => {
  const afterAir = buildTrackLinkContext({
    speakerPersona: speakerA,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: false,
    lastAiredLink: 'This is Joni Mitchell.',
  });
  assert.equal('displayText' in afterAir && afterAir.displayText, 'Next up, Neil Young.');

  const afterDropped = buildTrackLinkContext({
    speakerPersona: speakerA,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: false,
    lastAiredLink: 'This is Joni Mitchell.',
  });
  // A composed-then-dropped "Next up, Other." must not flip the next aired form.
  const wronglyAnchored = buildTrackLinkContext({
    speakerPersona: speakerA,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: false,
    lastAiredLink: 'Next up, Other Artist.',
  });
  assert.equal('displayText' in afterDropped && afterDropped.displayText, 'Next up, Neil Young.');
  assert.equal('displayText' in wronglyAnchored && wronglyAnchored.displayText, 'This is Neil Young.');
});

test('announce allows the optional title zero times and rejects a changed speaker', async () => {
  const built = buildTrackLinkContext({
    speakerPersona: speakerA,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: true,
    lastAiredLink: null,
  });
  if ('ok' in built) throw new Error('expected announce context');
  const ok = await runTextPolicy(request({
    displayText: built.displayText,
    persona: speakerA,
    rewriteAllowed: false,
    facts: { sourceBacked: false, factLocks: built.factLocks },
    linkContext: built.context,
  }), ctx());
  assert.equal(ok.ok, true);
  if (ok.ok) assert.doesNotMatch(ok.displayText, /Harvest/);

  const changed = await runTextPolicy(request({
    displayText: built.displayText,
    persona: speakerB,
    rewriteAllowed: false,
    facts: { sourceBacked: false, factLocks: built.factLocks },
    linkContext: built.context,
  }), ctx());
  assert.equal(changed.ok, false);
  if (!changed.ok) assert.ok(changed.failedRuleIds.includes('link-speaker'));

  const changedSoul = await runTextPolicy(request({
    displayText: built.displayText,
    persona: { ...speakerA, soul: 'A different on-air voice.' },
    rewriteAllowed: false,
    facts: { sourceBacked: false, factLocks: built.factLocks },
    linkContext: built.context,
  }), ctx());
  assert.equal(changedSoul.ok, false);
  if (!changedSoul.ok) assert.ok(changedSoul.failedRuleIds.includes('link-speaker'));
});

test('duplicate or changed optional title locks fail announce speech', async () => {
  const built = buildTrackLinkContext({
    speakerPersona: speakerA,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: true,
    lastAiredLink: null,
  });
  if ('ok' in built) throw new Error('expected announce context');
  const duplicate = await runTextPolicy(request({
    displayText: 'This is Neil Young. Harvest. Harvest.',
    persona: speakerA,
    facts: { sourceBacked: false, factLocks: built.factLocks },
    linkContext: built.context,
  }), ctx());
  assert.equal(duplicate.ok, false);

  const changedLock = await runTextPolicy(request({
    displayText: built.displayText,
    persona: speakerA,
    facts: {
      sourceBacked: false,
      factLocks: built.factLocks.map((lock) => (
        lock.id === 'track.title' ? { ...lock, displayValue: 'Harvest Moon' } : lock
      )),
    },
    linkContext: built.context,
  }), ctx());
  assert.equal(changedLock.ok, false);
});

test('track lock required flags are enforced by link style', async () => {
  const announce = buildTrackLinkContext({
    speakerPersona: speakerA,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: true,
    lastAiredLink: null,
  });
  if ('ok' in announce) throw new Error('expected announce context');
  const optionalArtist = await runTextPolicy(request({
    displayText: announce.displayText,
    persona: speakerA,
    facts: {
      sourceBacked: false,
      factLocks: announce.factLocks.map((lock) => (
        lock.id === 'track.artist' ? { ...lock, required: false } : lock
      )),
    },
    linkContext: announce.context,
  }), ctx());
  assert.equal(optionalArtist.ok, false);
  if (!optionalArtist.ok) assert.ok(optionalArtist.failedRuleIds.includes('link-locks'));

  const natural = buildTrackLinkContext({
    speakerPersona: naturalSpeaker,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: false,
    lastAiredLink: null,
  });
  if ('ok' in natural) throw new Error('expected natural context');
  const optionalTitle = await runTextPolicy(request({
    displayText: natural.displayText,
    persona: naturalSpeaker,
    facts: {
      sourceBacked: false,
      factLocks: natural.factLocks.map((lock) => (
        lock.id === 'track.title' ? { ...lock, required: false } : lock
      )),
    },
    linkContext: natural.context,
  }), ctx());
  assert.equal(optionalTitle.ok, false);
  if (!optionalTitle.ok) assert.ok(optionalTitle.failedRuleIds.includes('link-locks'));
});

test('natural links support identical artist and title in distinct spans', async () => {
  const built = buildTrackLinkContext({
    speakerPersona: naturalSpeaker,
    artist: 'Talk Talk',
    title: 'Talk Talk',
    currentIsOnAir: false,
    lastAiredLink: null,
  });
  if ('ok' in built) throw new Error('expected natural context');
  const result = await runTextPolicy(request({
    displayText: built.displayText,
    persona: naturalSpeaker,
    facts: { sourceBacked: false, factLocks: built.factLocks },
    linkContext: built.context,
  }), ctx());
  assert.equal(result.ok, true);
});

test('sentence-initial and contextual unlocked names use the natural fallback', async () => {
  const built = buildTrackLinkContext({
    speakerPersona: naturalSpeaker,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: false,
    lastAiredLink: null,
  });
  if ('ok' in built) throw new Error('expected natural context');
  for (const displayText of [
    'Winnipeg loves Neil Young with Harvest.',
    'Neil Young with Harvest near winnipeg.',
    'Neil Young with Harvest over winnipeg.',
    'Neil Young with Harvest beside winnipeg.',
    'Neil Young with Harvest near “winnipeg”.',
    'Neil Young with Harvest near the town of winnipeg.',
    'Neil Young with Harvest near snow lake.',
    'Neil Young with Harvest via winnipeg.',
    'Neil Young with Harvest between winnipeg and melita.',
    'Neil Young with Harvest throughout winnipeg.',
    'Neil Young with Harvest beyond winnipeg.',
    'Neil Young with Harvest in nice.',
    'Neil Young with Harvest via nice.',
    'Neil Young with Harvest near nice.',
    'Neil Young with Harvest from nice.',
    'A nice tune about nice from Neil Young, with Harvest.',
    'Neil Young and may with Harvest.',
  ]) {
    const result = await runTextPolicy(request({
      displayText,
      persona: naturalSpeaker,
      facts: { sourceBacked: false, factLocks: built.factLocks },
      linkContext: built.context,
    }), ctx());
    assert.equal(result.ok, true, displayText);
    if (result.ok) assert.equal(result.displayText, 'Neil Young, with Harvest.', displayText);
  }

  const ordinary = await runTextPolicy(request({
    displayText: 'Neil Young with Harvest over the air.',
    persona: naturalSpeaker,
    facts: { sourceBacked: false, factLocks: built.factLocks },
    linkContext: built.context,
  }), ctx());
  assert.equal(ordinary.ok, true);
  if (ordinary.ok) assert.equal(ordinary.displayText, 'Neil Young with Harvest over the air.');

  const varied = await runTextPolicy(request({
    displayText: 'A good tune from Neil Young, with Harvest.',
    persona: naturalSpeaker,
    facts: { sourceBacked: false, factLocks: built.factLocks },
    linkContext: built.context,
  }), ctx());
  assert.equal(varied.ok, true);
});

test('a failed natural form falls back to artist, with title and is not an LLM rewrite', async () => {
  const built = buildTrackLinkContext({
    speakerPersona: naturalSpeaker,
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: false,
    lastAiredLink: null,
  });
  if ('ok' in built) throw new Error('expected natural context');
  let calls = 0;
  const result = await runTextPolicy(request({
    displayText: 'Neil Young wrote Harvest after the chart release in 1972.',
    persona: naturalSpeaker,
    rewriteAllowed: true,
    facts: { sourceBacked: false, factLocks: built.factLocks },
    linkContext: built.context,
  }), ctx({
    rewriteFn: async () => {
      calls += 1;
      return 'should not run';
    },
  }));
  assert.equal(calls, 0);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.displayText, 'Neil Young, with Harvest.');
    assert.equal(result.rewriteCount, 0);
  }
});

test('an empty announceLine rejects QA-enabled speech', () => {
  const built = buildTrackLinkContext({
    speakerPersona: { ...speakerA, language: 'French' },
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: false,
    lastAiredLink: null,
  });
  assert.equal('ok' in built && built.ok === false, true);

  const missingId = buildTrackLinkContext({
    speakerPersona: { ...speakerA, id: '' },
    artist: 'Neil Young',
    title: 'Harvest',
    currentIsOnAir: true,
    lastAiredLink: null,
  });
  assert.equal('ok' in missingId && missingId.ok === false, true);
});

test('speech corrections change spoken text only', async () => {
  const result = await runTextPolicy(request({
    displayText: 'A stop in Melita.',
    facts: { sourceBacked: false, factLocks: [{ id: 'place.town', displayValue: 'Melita', required: true, spokenValue: 'Meleeta' }] },
  }), ctx({
    corrections: [{ from: 'Melita', to: 'Meleeta' }],
  }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.displayText, 'A stop in Melita.');
    assert.equal(result.spokenText, 'A stop in Meleeta.');
  }
});

test('speech corrections cannot move a locked value to another span', async () => {
  const result = await runTextPolicy(request({
    displayText: 'Melita beside alias.',
    facts: {
      sourceBacked: false,
      factLocks: [{ id: 'place.town', displayValue: 'Melita', required: true }],
    },
  }), ctx({
    corrections: [
      { from: 'Melita', to: 'Meleeta' },
      { from: 'alias', to: 'Melita' },
    ],
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.failedRuleIds.includes('spoken-fact'));
});

test('speech corrections cannot target or reorder opaque fact sentinels', async () => {
  const locks = [{ id: 'place.town', displayValue: 'Melita', required: true }];
  const tokenized = tokenizeFactLocks('Melita beside marker.', locks);
  if (!('tokens' in tokenized)) throw new Error(tokenized.message);
  const result = await runTextPolicy(request({
    displayText: 'Melita beside marker.',
    facts: { sourceBacked: false, factLocks: locks },
  }), ctx({
    corrections: [{
      from: tokenized.text,
      to: `marker beside ${tokenized.tokens[0].token}.`,
    }],
  }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.spokenText, 'Melita beside marker.');
});

test('spoken corrections are rechecked for banned copy and new facts', async () => {
  const banned = await runTextPolicy(request({
    displayText: 'Plain words.',
  }), ctx({
    policy: policy({
      rules: [{ id: 'ban-ai', type: 'phrase', value: 'as an AI' }],
    }),
    corrections: [{
      from: 'Plain words',
      to: 'As an AI, it is 8 PM in Winnipeg',
    }],
  }));
  assert.equal(banned.ok, false);
  if (!banned.ok) assert.ok(banned.failedRuleIds.includes('ban-ai'));

  const factual = await runTextPolicy(request({
    displayText: 'Plain words.',
  }), ctx({
    corrections: [{
      from: 'Plain words',
      to: 'plain words in september near winnipeg',
    }],
  }));
  assert.equal(factual.ok, false);
  if (!factual.ok) assert.ok(factual.failedRuleIds.includes('spoken-fact'));
});

test('ordinary weather and roads sentence openers are not treated as names', async () => {
  const weather = await runTextPolicy(request({
    displayText: 'Warm air over town near Melita.',
    facts: {
      sourceBacked: false,
      factLocks: [{ id: 'place.town', displayValue: 'Melita', required: true }],
    },
  }), ctx());
  assert.equal(weather.ok, true);

  const roads = await runTextPolicy(request({
    displayText: 'Skies clear near Melita.',
    facts: {
      sourceBacked: true,
      factLocks: [{
        id: 'copy.full',
        displayValue: 'Skies clear near Melita.',
        required: true,
        sourceRef: 'citypage:melita',
        sourceRevision: 'r1',
      }],
      provenance: lease(),
    },
  }), ctx());
  assert.equal(roads.ok, true);

  const modalMay = await runTextPolicy(request({
    displayText: 'It may rain in Melita.',
    facts: {
      sourceBacked: false,
      factLocks: [
        { id: 'condition.rain', displayValue: 'rain', required: true },
        { id: 'place.town', displayValue: 'Melita', required: true },
      ],
    },
  }), ctx());
  assert.equal(modalMay.ok, true);
});

test('source-backed copy rejects assertions outside its bound locks', async () => {
  for (const displayText of [
    'Melita won the lottery.',
    'It is affecting Melita.',
    'It is covering Melita.',
  ]) {
    const result = await runTextPolicy(request({
      displayText,
      facts: {
        sourceBacked: true,
        factLocks: [{
          id: 'place.town',
          displayValue: 'Melita',
          required: true,
          sourceRef: 'citypage:melita',
          sourceRevision: 'r1',
        }],
        provenance: lease(),
      },
    }), ctx());
    assert.equal(result.ok, false, displayText);
    if (!result.ok) {
      assert.ok(result.failedRuleIds.includes('provenance'), displayText);
      assert.match(result.message, /full-copy source lock/, displayText);
    }
  }

  const ambiguous = await runTextPolicy(request({
    displayText: 'The warning is over in Melita.',
    facts: {
      sourceBacked: true,
      factLocks: [
        {
          id: 'event.warning',
          displayValue: 'warning',
          required: true,
          sourceRef: 'citypage:melita',
          sourceRevision: 'r1',
        },
        {
          id: 'place.town',
          displayValue: 'Melita',
          required: true,
          sourceRef: 'citypage:melita',
          sourceRevision: 'r1',
        },
      ],
      provenance: lease(),
    },
  }), ctx());
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.match(ambiguous.message, /full-copy source lock/);
});

test('disabled default policy still accepts ordinary copy', async () => {
  const result = await runTextPolicy(request({
    displayText: 'Clear skies over town.',
  }), ctx({ policy: DEFAULTS.tts.broadcastQa }));
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.rewriteCount, 0);
});

test('inherited object keys are never accepted as duration profiles', async () => {
  for (const profile of ['__proto__', 'constructor', 'toString']) {
    const result = await runTextPolicy(request({ profile }), ctx());
    assert.equal(result.ok, false, profile);
    if (!result.ok) assert.equal(result.code, 'unsupported_profile', profile);
  }
});
