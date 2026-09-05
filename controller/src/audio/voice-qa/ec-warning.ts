// Deterministic Environment Canada warning copy. The only shortening is one
// removal of the optional timing field. An LLM never sees the CAP body.

import type { EcWarningCopyProof } from '../../schemas/voice.js';
import { canonicalSha256 } from '../../util/canonical-json.js';

export const EC_WARNING_URL_TEXT = 'weather.gc.ca' as const;

export type EcWarningFields = {
  event: string;
  headline: string;
  verifiedPlaces: readonly string[];
  timing?: string;
};

function formatPlaces(places: readonly string[]): string {
  const clean = places.map((p) => p.trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  return `${clean.slice(0, -1).join(', ')}, and ${clean[clean.length - 1]}`;
}

function timingSegment(timing: string | undefined): string {
  const t = timing?.trim();
  return t ? `, ${t}` : '';
}

function composeCore(fields: EcWarningFields, includeTiming: boolean): string {
  const places = formatPlaces(fields.verifiedPlaces);
  const placeClause = places ? `, affecting ${places}` : '';
  const timing = includeTiming ? timingSegment(fields.timing) : '';
  return `${fields.event.trim()}: ${fields.headline.trim()}${placeClause}${timing}. Details at ${EC_WARNING_URL_TEXT}.`;
}

export function composeEcWarningFull(fields: EcWarningFields): string {
  return composeCore(fields, true);
}

export function composeEcWarningMandatory(fields: EcWarningFields): string {
  return composeCore(fields, false);
}

export function removeTimingOnce(fullDisplayText: string, timing: string | undefined): string {
  const segment = timingSegment(timing);
  if (!segment) return fullDisplayText;
  // Timing occupies one structural slot: immediately before the final period
  // and fixed Details sentence. Never search from the front — the same words
  // may legitimately occur in the CAP headline.
  const ending = `${segment}. Details at ${EC_WARNING_URL_TEXT}.`;
  if (!fullDisplayText.endsWith(ending)) return fullDisplayText;
  return `${fullDisplayText.slice(0, -ending.length)}. Details at ${EC_WARNING_URL_TEXT}.`;
}

export function hashEcWarningText(text: string): string {
  return canonicalSha256(text);
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export type EcWarningVerifyOk = { ok: true; fullDisplayText: string; mandatoryDisplayText: string };
export type EcWarningVerifyFail = { ok: false; message: string };

export function verifyEcWarningCopyProof(
  proof: EcWarningCopyProof,
): EcWarningVerifyOk | EcWarningVerifyFail {
  if (proof.requiredUrlText !== EC_WARNING_URL_TEXT) {
    return { ok: false, message: 'EC warning copy must cite weather.gc.ca' };
  }
  if (!proof.verifiedPlaces.length) {
    return { ok: false, message: 'EC warning copy needs at least one verified place' };
  }
  const fields: EcWarningFields = {
    event: proof.event,
    headline: proof.headline,
    verifiedPlaces: proof.verifiedPlaces,
    timing: proof.timing,
  };
  const fullDisplayText = composeEcWarningFull(fields);
  const mandatoryDisplayText = composeEcWarningMandatory(fields);
  if (fullDisplayText !== proof.fullDisplayText) {
    return { ok: false, message: 'EC warning full display text does not match the proof fields' };
  }
  if (mandatoryDisplayText !== proof.mandatoryDisplayText) {
    return { ok: false, message: 'EC warning mandatory display text does not match the proof fields' };
  }
  if (removeTimingOnce(fullDisplayText, proof.timing) !== mandatoryDisplayText) {
    return { ok: false, message: 'EC warning mandatory copy must be full copy with timing removed once' };
  }
  if (hashEcWarningText(fullDisplayText) !== proof.fullTextHash) {
    return { ok: false, message: 'EC warning full text hash does not match' };
  }
  if (hashEcWarningText(mandatoryDisplayText) !== proof.mandatoryTextHash) {
    return { ok: false, message: 'EC warning mandatory text hash does not match' };
  }
  return { ok: true, fullDisplayText, mandatoryDisplayText };
}

export type EcWarningSelection =
  | { ok: true; variant: 'full' | 'mandatory'; displayText: string }
  | { ok: false; abstain: true; message: string };

export function selectEcWarningDisplay(
  proof: EcWarningCopyProof,
  maxWords: number,
): EcWarningSelection {
  const verified = verifyEcWarningCopyProof(proof);
  if (!verified.ok) return { ok: false, abstain: true, message: verified.message };
  if (wordCount(verified.fullDisplayText) <= maxWords) {
    return { ok: true, variant: 'full', displayText: verified.fullDisplayText };
  }
  if (wordCount(verified.mandatoryDisplayText) <= maxWords) {
    return { ok: true, variant: 'mandatory', displayText: verified.mandatoryDisplayText };
  }
  return {
    ok: false,
    abstain: true,
    message: 'EC warning mandatory copy exceeds the duration profile word budget',
  };
}
