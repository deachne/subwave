// Fact-lock tokenize / restore / spoken-value contract.
// Run: npx tsx scripts/voice-fact-locks.test.ts

import assert from 'node:assert/strict';
import test from 'node:test';

import type { FactLock } from '../src/schemas/voice.js';
import { canonicalSha256 } from '../src/util/canonical-json.js';
import {
  allocateFactLockSpans,
  factLockHash8,
  factLocksHash,
  restoreFactLocks,
  sortLocksLongestFirst,
  tokenizeFactLocks,
  validateFactLockIds,
  validatePreservedFactTokens,
  validateRestoredCardinality,
  validateRewriteTokens,
  validateSpokenLocks,
} from '../src/audio/voice-qa/fact-locks.js';

const town: FactLock = { id: 'place.town', displayValue: 'Melita', required: true };
const region: FactLock = {
  id: 'place.region',
  displayValue: 'Melita, Manitoba',
  required: true,
};
const optional: FactLock = { id: 'wind.dir', displayValue: 'northwest', required: false };

test('lock ids must match the stable pattern and be unique', () => {
  assert.equal(validateFactLockIds([town, region]).ok, true);
  assert.equal(validateFactLockIds([{ ...town, id: 'Town' }]).ok, false);
  assert.equal(validateFactLockIds([town, { ...region, id: 'place.town' }]).ok, false);
});

test('longest display values are tokenized first so nested values survive', () => {
  const ordered = sortLocksLongestFirst([town, region]);
  assert.deepEqual(ordered.map((lock) => lock.id), ['place.region', 'place.town']);
  const tokenized = tokenizeFactLocks('Warning for Melita, Manitoba and Melita.', [town, region]);
  assert.equal('tokens' in tokenized, true);
  if (!('tokens' in tokenized)) return;
  assert.match(tokenized.tokens[0].token, /^\[\[FACT_0_[0-9a-f]{8}\]\]$/);
  assert.equal(tokenized.tokens[0].hash8, factLockHash8(region));
  assert.equal(tokenized.text, `Warning for ${tokenized.tokens[0].token} and ${tokenized.tokens[1].token}.`);
  const restored = restoreFactLocks(tokenized.text, tokenized.tokens);
  assert.equal(restored.ok, true);
  if (restored.ok) {
    assert.equal(restored.text, 'Warning for Melita, Manitoba and Melita.');
  }
});

test('required tokens must appear exactly once; optional tokens at most once', () => {
  const tokenized = tokenizeFactLocks('Wind from the northwest at Melita.', [town, optional]);
  assert.equal('tokens' in tokenized, true);
  if (!('tokens' in tokenized)) return;
  assert.equal(validateRewriteTokens(tokenized.text, tokenized.tokens).ok, true);

  const missing = tokenized.text.replace(tokenized.tokens.find((t) => t.lock.id === 'place.town')!.token, 'somewhere');
  assert.match(validateRewriteTokens(missing, tokenized.tokens).message, /missing required/);

  const townToken = tokenized.tokens.find((t) => t.lock.id === 'place.town')!.token;
  assert.match(
    validateRewriteTokens(`${tokenized.text} ${townToken}`, tokenized.tokens).message,
    /duplicated required/,
  );

  const windToken = tokenized.tokens.find((t) => t.lock.id === 'wind.dir')!.token;
  const noOptional = tokenized.text.replace(windToken, 'that way');
  assert.equal(validateRewriteTokens(noOptional, tokenized.tokens).ok, true);
  assert.match(
    validateRewriteTokens(`${tokenized.text} ${windToken}`, tokenized.tokens).message,
    /duplicated optional/,
  );
});

test('unknown or changed tokens reject the rewrite', () => {
  const tokenized = tokenizeFactLocks('Melita is clear.', [town]);
  assert.equal('tokens' in tokenized, true);
  if (!('tokens' in tokenized)) return;
  assert.match(
    validateRewriteTokens('[[FACT_0_deadbeef]] is clear.', tokenized.tokens).message,
    /unknown or changed/,
  );
  assert.match(
    validateRewriteTokens('[[FACT_9_aaaaaaaa]] is clear.', tokenized.tokens).message,
    /unknown or changed/,
  );
});

test('rewrites cannot insert optional facts or reverse fact relationships', () => {
  const absentOptional = tokenizeFactLocks('Melita is clear.', [town, optional]);
  if (!('tokens' in absentOptional)) throw new Error(absentOptional.message);
  const optionalToken = absentOptional.tokens.find((token) => token.lock.id === optional.id)!;
  assert.match(
    validateRewriteTokens(`${absentOptional.text} ${optionalToken.token}`, absentOptional.tokens).message,
    /inserted optional/,
  );

  const places: FactLock[] = [
    { id: 'place.first', displayValue: 'Melita', required: true },
    { id: 'place.second', displayValue: 'Waskada', required: true },
  ];
  const tokenized = tokenizeFactLocks('Melita is north of Waskada.', places);
  if (!('tokens' in tokenized)) throw new Error(tokenized.message);
  const first = tokenized.tokens.find((token) => token.lock.id === 'place.first')!;
  const second = tokenized.tokens.find((token) => token.lock.id === 'place.second')!;
  assert.match(
    validateRewriteTokens(
      `${second.token} is north of ${first.token}.`,
      tokenized.tokens,
    ).message,
    /reordered fact tokens/,
  );
  assert.match(
    validateRewriteTokens(
      `${first.token} is south of ${second.token}.`,
      tokenized.tokens,
      { sourceText: tokenized.text },
    ).message,
    /approved non-semantic opener/,
  );

  const withOptional = tokenizeFactLocks(
    'Melita before Brandon after Waskada.',
    [
      places[0],
      { id: 'place.optional', displayValue: 'Brandon', required: false },
      places[1],
    ],
  );
  if (!('tokens' in withOptional)) throw new Error(withOptional.message);
  const optionalById = new Map(
    withOptional.tokens.map((token) => [token.lock.id, token.token]),
  );
  assert.match(
    validateRewriteTokens(
      `${optionalById.get('place.first')} after ${optionalById.get('place.second')}.`,
      withOptional.tokens,
      { sourceText: withOptional.text },
    ).message,
    /presence or order/,
  );

  assert.match(
    validateRewriteTokens(
      `It is not true that ${first.token} is north of ${second.token}.`,
      tokenized.tokens,
      { sourceText: tokenized.text },
    ).message,
    /approved non-semantic opener/,
  );
});

test('a speech correction cannot change a lock without an approved spoken value', () => {
  const locks: FactLock[] = [town];
  assert.equal(validateSpokenLocks('Minus eighteen in Melita.', locks).ok, true);
  assert.equal(validateSpokenLocks('Minus eighteen in Meleeta.', locks).ok, false);
  const spoken: FactLock[] = [{ ...town, spokenValue: 'Meleeta' }];
  assert.equal(validateSpokenLocks('Minus eighteen in Meleeta.', spoken).ok, true);
  assert.equal(validateSpokenLocks('Minus eighteen in Melita.', spoken).ok, false);
});

test('restored cardinality and the lock hash are stable', () => {
  const locks = [region, town];
  assert.equal(validateRestoredCardinality('Warning for Melita, Manitoba and Melita.', locks).ok, true);
  assert.equal(validateRestoredCardinality('Warning for Melita and Melita.', locks).ok, false);
  assert.equal(factLocksHash(locks), canonicalSha256(locks));
  assert.equal(factLocksHash([town, region]), canonicalSha256([town, region]));
  assert.notEqual(factLocksHash([town, region]), factLocksHash([region, town]));
});

test('lock matches are isolated and never hide inside a larger word', () => {
  assert.equal(validateRestoredCardinality('Melitaville is clear.', [town]).ok, false);
  assert.equal(validateRestoredCardinality('Melita is clear.', [town]).ok, true);
});

test('duplicate metadata values receive distinct non-overlapping tokens', () => {
  const locks: FactLock[] = [
    { id: 'track.artist', displayValue: 'Talk Talk', required: true },
    { id: 'track.title', displayValue: 'Talk Talk', required: true },
  ];
  const tokenized = tokenizeFactLocks('Talk Talk, with Talk Talk.', locks);
  assert.equal('tokens' in tokenized, true);
  if (!('tokens' in tokenized)) return;
  assert.notEqual(tokenized.tokens[0].token, tokenized.tokens[1].token);
  assert.equal(tokenized.text.includes(tokenized.tokens[0].token), true);
  assert.equal(tokenized.text.includes(tokenized.tokens[1].token), true);
  assert.equal(restoreFactLocks(tokenized.text, tokenized.tokens).ok, true);
});

test('ambiguous duplicate and missing spans fail closed', () => {
  assert.match(
    validateRestoredCardinality('Melita and Melita.', [town]).message,
    /duplicated required/,
  );
  const duplicateLocks: FactLock[] = [
    { id: 'place.one', displayValue: 'Melita', required: true },
    { id: 'place.two', displayValue: 'Melita', required: true },
  ];
  assert.match(
    validateRestoredCardinality('Only Melita.', duplicateLocks).message,
    /missing required/,
  );
});

test('speech normalization must preserve every sentinel it receives', () => {
  const tokenized = tokenizeFactLocks('Weather for Melita.', [town]);
  if (!('tokens' in tokenized)) throw new Error(tokenized.message);
  assert.equal(
    validatePreservedFactTokens(tokenized.text, tokenized.text, tokenized.tokens).ok,
    true,
  );
  assert.equal(
    validatePreservedFactTokens(
      tokenized.text,
      tokenized.text.replace('FACT_', 'MOVED_'),
      tokenized.tokens,
    ).ok,
    false,
  );
});

test('one compatibility-folded grapheme cannot satisfy two source spans', () => {
  const locks: FactLock[] = [
    { id: 'letter.one', displayValue: 'f', required: true },
    { id: 'letter.two', displayValue: 'f', required: true },
  ];
  const allocation = allocateFactLockSpans('ﬃ', locks);
  assert.equal(allocation.ok, false);
  assert.equal(
    allocateFactLockSpans('½', [{
      id: 'number.one',
      displayValue: '1',
      required: true,
    }]).ok,
    false,
  );
});
