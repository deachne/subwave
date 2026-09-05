// Deterministic EC warning copy — two variants, timing removed once, no LLM.
// Run: npx tsx scripts/ec-warning-copy.test.ts

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-ec-warning-'));

const {
  composeEcWarningFull,
  composeEcWarningMandatory,
  hashEcWarningText,
  removeTimingOnce,
  selectEcWarningDisplay,
  verifyEcWarningCopyProof,
  wordCount,
} = await import('../src/audio/voice-qa/ec-warning.js');
const { runTextPolicy } = await import('../src/audio/voice-qa/text-policy.js');
const { BROADCAST_QA_PROFILES } = await import('../src/schemas/voice.js');
const { DEFAULTS } = await import('../src/settings/defaults.js');

const fields = {
  event: 'Winter Storm Warning',
  headline: 'Heavy snow and blowing snow',
  verifiedPlaces: ['Melita', 'Deloraine'],
  timing: 'until 8 PM',
};

function proofFrom(f = fields) {
  const fullDisplayText = composeEcWarningFull(f);
  const mandatoryDisplayText = composeEcWarningMandatory(f);
  return {
    schemaVersion: 1 as const,
    alertReference: 'cap:example',
    alertRevision: 'r1',
    event: f.event,
    headline: f.headline,
    verifiedPlaces: [...f.verifiedPlaces],
    timing: f.timing,
    requiredUrlText: 'weather.gc.ca' as const,
    fullDisplayText,
    mandatoryDisplayText,
    fullTextHash: hashEcWarningText(fullDisplayText),
    mandatoryTextHash: hashEcWarningText(mandatoryDisplayText),
  };
}

function ecProvenance(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    skillId: 'weather-ec',
    sourceId: 'ec-cap',
    sourceRef: 'cap:example',
    attribution: 'Environment Canada',
    fetchedAt: '2026-09-05T18:00:00.000Z',
    expiresAt: '2026-09-06T18:00:00.000Z',
    entityKey: 'warning:1',
    sourceRevision: 'r1',
    payloadHash: 'p1',
    candidateRevision: 'c1',
    revalidationKey: 'k1',
    ...overrides,
  };
}

function ecRequest(proof = proofFrom(), overrides: Record<string, unknown> = {}) {
  return {
    auditId: 'ec-1',
    displayText: 'ignore me',
    kind: 'weather',
    profile: 'ec-warning',
    automatic: true,
    rewriteAllowed: true,
    rewriteCount: 0,
    legacyGainDb: 0,
    facts: {
      sourceBacked: true,
      factLocks: [],
      provenance: ecProvenance(),
    },
    ecWarning: proof,
    ...overrides,
  };
}

test('full copy carries event, places, timing, and weather.gc.ca', () => {
  const full = composeEcWarningFull(fields);
  assert.match(full, /Winter Storm Warning/);
  assert.match(full, /Heavy snow and blowing snow/);
  assert.match(full, /Melita and Deloraine/);
  assert.match(full, /until 8 PM/);
  assert.match(full, /weather\.gc\.ca/);
});

test('mandatory copy is full copy with timing removed once', () => {
  const full = composeEcWarningFull(fields);
  const mandatory = composeEcWarningMandatory(fields);
  assert.equal(removeTimingOnce(full, fields.timing), mandatory);
  assert.doesNotMatch(mandatory, /until 8 PM/);
  assert.match(mandatory, /weather\.gc\.ca/);
  assert.equal(full.indexOf(', until 8 PM'), full.lastIndexOf(', until 8 PM'));
});

test('timing that also appears in the headline is not stripped from the headline', () => {
  const overlapping = {
    ...fields,
    headline: 'Snow, until 8 PM, remains in the corridor',
    timing: 'until 8 PM',
  };
  const full = composeEcWarningFull(overlapping);
  const mandatory = composeEcWarningMandatory(overlapping);
  assert.equal(removeTimingOnce(full, overlapping.timing), mandatory);
  assert.match(mandatory, /Snow, until 8 PM, remains in the corridor/);
  assert.equal(mandatory.endsWith('Details at weather.gc.ca.'), true);
});

test('a matching proof verifies; a widened or rehashed proof does not', () => {
  const proof = proofFrom();
  assert.equal(verifyEcWarningCopyProof(proof).ok, true);
  assert.equal(verifyEcWarningCopyProof({ ...proof, fullDisplayText: `${proof.fullDisplayText} extra` }).ok, false);
  assert.equal(verifyEcWarningCopyProof({ ...proof, fullTextHash: '0'.repeat(64) }).ok, false);
});

test('word budget prefers full copy, then mandatory, then abstains', () => {
  const proof = proofFrom();
  const fullWords = wordCount(proof.fullDisplayText);
  const picked = selectEcWarningDisplay(proof, BROADCAST_QA_PROFILES['ec-warning'].maxWords);
  assert.equal(picked.ok, true);
  if (picked.ok) assert.equal(picked.variant, 'full');

  const mandatoryOnly = selectEcWarningDisplay(proof, fullWords - 1);
  assert.equal(mandatoryOnly.ok, true);
  if (mandatoryOnly.ok) assert.equal(mandatoryOnly.variant, 'mandatory');

  const abstain = selectEcWarningDisplay(proof, 3);
  assert.equal(abstain.ok, false);
  if (!abstain.ok) assert.equal(abstain.abstain, true);
});

test('runTextPolicy never calls rewrite for an EC warning', async () => {
  const proof = proofFrom();
  let rewriteCalls = 0;
  const result = await runTextPolicy({
    auditId: 'ec-1',
    displayText: 'ignore me',
    kind: 'weather',
    profile: 'ec-warning',
    automatic: true,
    rewriteAllowed: true,
    rewriteCount: 0,
    legacyGainDb: 0,
    facts: {
      sourceBacked: true,
      factLocks: [],
      provenance: {
        schemaVersion: 1,
        skillId: 'weather-ec',
        sourceId: 'ec-cap',
        sourceRef: 'cap:example',
        attribution: 'Environment Canada',
        fetchedAt: '2026-09-05T18:00:00.000Z',
        expiresAt: '2026-09-06T18:00:00.000Z',
        entityKey: 'warning:1',
        sourceRevision: 'r1',
        payloadHash: 'p1',
        candidateRevision: 'c1',
        revalidationKey: 'k1',
      },
    },
    ecWarning: proof,
  }, {
    policy: DEFAULTS.tts.broadcastQa,
    corrections: [],
    nowMs: Date.parse('2026-09-05T19:00:00.000Z'),
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
    rolling: { history: [], reservations: [] },
    rewriteFn: async () => {
      rewriteCalls += 1;
      throw new Error('EC warning must not enter rewrite');
    },
  });
  assert.equal(rewriteCalls, 0);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.displayText, proof.fullDisplayText);
    assert.equal(result.rewriteCount, 0);
  }
});

test('EC proof requires source-backed matching provenance', async () => {
  const unbacked = await runTextPolicy(ecRequest(proofFrom(), {
    facts: { sourceBacked: false, factLocks: [] },
  }) as any, {
    policy: DEFAULTS.tts.broadcastQa,
    corrections: [],
    nowMs: Date.parse('2026-09-05T19:00:00.000Z'),
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
    rolling: { history: [], reservations: [] },
  });
  assert.equal(unbacked.ok, false);

  const mismatched = await runTextPolicy(ecRequest(proofFrom(), {
    facts: {
      sourceBacked: true,
      factLocks: [],
      provenance: ecProvenance({ sourceRevision: 'r2' }),
    },
  }) as any, {
    policy: DEFAULTS.tts.broadcastQa,
    corrections: [],
    nowMs: Date.parse('2026-09-05T19:00:00.000Z'),
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
    rolling: { history: [], reservations: [] },
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) assert.ok(mismatched.failedRuleIds.includes('provenance'));
});

test('configured replacements cannot change final verified EC copy', async () => {
  const result = await runTextPolicy(ecRequest() as any, {
    policy: {
      ...DEFAULTS.tts.broadcastQa,
      replacements: [{
        id: 'mutate-ec',
        match: 'affecting',
        replacement: 'covering',
        caseSensitive: true,
        boundary: 'both',
      }],
    },
    corrections: [],
    nowMs: Date.parse('2026-09-05T19:00:00.000Z'),
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
    rolling: { history: [], reservations: [] },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.failedRuleIds.includes('ec-warning-final'));
});

test('verified EC fields cannot hide presentation directions', async () => {
  const stagedProof = proofFrom({
    ...fields,
    headline: '[speaking slowly] Heavy snow expected',
  });
  const result = await runTextPolicy(ecRequest(stagedProof) as any, {
    policy: DEFAULTS.tts.broadcastQa,
    corrections: [],
    nowMs: Date.parse('2026-09-05T19:00:00.000Z'),
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
    rolling: { history: [], reservations: [] },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.failedRuleIds.includes('stage-direction'));
});

test('malformed EC proof objects fail runtime parsing', async () => {
  const proof = { ...proofFrom(), trustedWithoutVerification: true };
  const result = await runTextPolicy(ecRequest(proof as any) as any, {
    policy: DEFAULTS.tts.broadcastQa,
    corrections: [],
    nowMs: Date.parse('2026-09-05T19:00:00.000Z'),
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
    rolling: { history: [], reservations: [] },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.failedRuleIds.includes('ec-warning'));
});

test('speech corrections cannot diverge from verified EC copy', async () => {
  const result = await runTextPolicy(ecRequest() as any, {
    policy: DEFAULTS.tts.broadcastQa,
    corrections: [{
      from: 'Details at',
      to: 'According to another source, details are at',
    }],
    nowMs: Date.parse('2026-09-05T19:00:00.000Z'),
    stationHourKey: '2026-09-05T14-0500@America_Winnipeg',
    rolling: { history: [], reservations: [] },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.failedRuleIds.includes('spoken-policy'));
});
