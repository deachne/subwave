// Pre-TTS display policy. Order is load-bearing: thinking strip → display
// normalize → replacements → validate → one rewrite → restore locks →
// re-validate → speech normalize → script scrub → spoken fact check.

import { announceLine, nextAnnounceForm } from '../../broadcast/announce-line.js';
import type { Persona } from '../../broadcast/queue/types.js';
import { stripThinking } from '../../llm/sdk.js';
import {
  BROADCAST_QA_PROFILES,
  ecWarningCopyProofSchema,
  factLockSchema,
  provenanceLeaseSchema,
  type BroadcastQaReplacement,
  type BroadcastQaRule,
  type BroadcastQaSettings,
  type EcWarningCopyProof,
  type FactLock,
  type ProvenanceLease,
} from '../../schemas/voice.js';
import { announceLinks } from '../../settings.js';
import { canonicalSha256 } from '../../util/canonical-json.js';
import {
  applySpeechCorrections,
  normalizeForDisplay,
  normalizeForSpeech,
  type SpeechCorrection,
} from '../speech-text.js';
import { scrubCjkForSpeech } from '../spoken-script-policy.js';
import type {
  VoiceLinkContext,
  VoiceQaStage,
  VoiceRejectCode,
  VoiceRenderRequest,
} from './contracts.js';
import { hashEcWarningText, selectEcWarningDisplay } from './ec-warning.js';
import {
  addedFactualClaims,
  allocateFactLockSpans,
  factLocksHash,
  findCapitalizedProperNames,
  findLiteralMatches,
  findNewFactualClaims,
  findUnlockedSourceWords,
  maskLockedSpans,
  restoreFactLocks,
  restoreSpokenFactLocks,
  spokenLockExpected,
  tokenizeFactLocks,
  validateFactLockIds,
  validatePreservedFactTokens,
  validateRestoredCardinality,
  validateRewriteTokens,
  validateSpokenLocks,
  type FactToken,
} from './fact-locks.js';
import { rewriteDisplayText, type VoiceRewriteFn } from './rewrite.js';

export { findLiteralMatches } from './fact-locks.js';

export type TextPolicyReplacement = {
  ruleId: string;
  step: number;
  inputTextHash: string;
  sourceStart: number;
  sourceEnd: number;
  matchedText: string;
  matchedTextHash: string;
  replacement: string;
};

export type RollingOccurrence = {
  ruleId: string;
  value: string;
  stationHourKey: string;
};

export type TextPolicyContext = {
  policy: BroadcastQaSettings;
  corrections: readonly SpeechCorrection[];
  nowMs: number;
  stationHourKey: string;
  rolling: {
    history: readonly RollingOccurrence[];
    reservations: readonly RollingOccurrence[];
  };
  rewriteFn?: VoiceRewriteFn;
};

export type TextPolicySuccess = {
  ok: true;
  displayText: string;
  spokenText: string;
  rewriteCount: 0 | 1;
  replacements: TextPolicyReplacement[];
  passedRuleIds: string[];
  failedRuleIds: [];
  factLocksHash: string;
};

export type TextPolicyFailure = {
  ok: false;
  code: VoiceRejectCode;
  stage: VoiceQaStage;
  message: string;
  failedRuleIds: string[];
  replacements: TextPolicyReplacement[];
};

const OPENING_PUNCT = /["'“”‘’«»(\[{]/;

export function firstNonEmptyLine(text: string): { text: string; start: number } | null {
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) return { text: line, start: offset };
    offset += line.length + 1;
  }
  return null;
}

export function splitSentences(text: string): Array<{ text: string; start: number }> {
  const sentences: Array<{ text: string; start: number }> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
    let end = i + 1;
    while (end < text.length && /["'”’»)\]}]/u.test(text[end])) end++;
    const next = text[end];
    if (next && !/\s/.test(next)) continue;
    const body = text.slice(start, end).trim();
    if (body) {
      const lead = text.slice(start).search(/\S/);
      sentences.push({ text: body, start: start + (lead < 0 ? 0 : lead) });
    }
    start = end;
    i = end - 1;
  }
  const tail = text.slice(start);
  if (tail.trim()) {
    const lead = tail.search(/\S/);
    sentences.push({ text: tail.trim(), start: start + (lead < 0 ? 0 : lead) });
  }
  return sentences;
}

function stripOpeningPunct(text: string): { text: string; offset: number } {
  let i = 0;
  while (i < text.length && (/\s/.test(text[i]) || OPENING_PUNCT.test(text[i]))) i++;
  return { text: text.slice(i), offset: i };
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

function durationProfileFor(profile: unknown) {
  if (
    typeof profile !== 'string'
    || !Object.prototype.hasOwnProperty.call(BROADCAST_QA_PROFILES, profile)
  ) {
    return null;
  }
  return BROADCAST_QA_PROFILES[profile as keyof typeof BROADCAST_QA_PROFILES];
}

function leftoverPresentation(masked: string): string[] {
  const failed: string[] = [];
  if (
    /[*`#_~]/u.test(masked)
    || /^\s*>+/mu.test(masked)
    || /^\s*(?:[-+]|\d+[.)])\s+/mu.test(masked)
    || /^\s*(?:[•‣⁃]|\p{So}|\p{Sm})\s*/mu.test(masked)
    || /<\/?\p{L}[^>\n]*>/u.test(masked)
  ) {
    failed.push('markdown');
  }
  if (
    /^\s*\p{L}[\p{L}\p{M}\p{N}'’/&\-]*(?:[ \t]+[\p{L}\p{N}][\p{L}\p{M}\p{N}'’/&\-]*){0,5}:[ \t]*/mu
      .test(masked)
  ) {
    failed.push('label');
  }
  if (/[\[\]]/u.test(masked)) failed.push('stage-direction');
  return failed;
}

export function openerHits(haystack: string, opener: string): boolean {
  const stripped = stripOpeningPunct(haystack);
  return findLiteralMatches(stripped.text, opener, {
    caseSensitive: false,
    boundary: 'both',
  }).some((span) => span.start === 0);
}

export type DisplayCheck = {
  failedRuleIds: string[];
  passedRuleIds: string[];
  message: string;
};

function rollingWouldExceed(
  rule: Extract<BroadcastQaRule, { type: 'station-hour-limit' }>,
  text: string,
  context: TextPolicyContext,
): boolean {
  const inText = findLiteralMatches(text, rule.value, {
    caseSensitive: false,
    boundary: 'both',
  }).length;
  if (inText === 0) return false;
  const prior = [...context.rolling.history, ...context.rolling.reservations]
    .filter((row) => (
      row.ruleId === rule.id
      && row.value === rule.value
      && row.stationHourKey === context.stationHourKey
    ))
    .length;
  return inText + prior > rule.max;
}

export function checkDisplayText(
  text: string,
  request: VoiceRenderRequest,
  context: TextPolicyContext,
  locks: readonly FactLock[],
): DisplayCheck {
  const failedRuleIds: string[] = [];
  const passedRuleIds: string[] = [];
  const notes: string[] = [];
  const profile = durationProfileFor(request.profile);
  const trimmed = text.trim();
  if (!trimmed) {
    failedRuleIds.push('empty');
    notes.push('display text is empty');
  }
  if (profile && wordCount(trimmed) > profile.maxWords) {
    failedRuleIds.push('max-words');
    notes.push(`display text exceeds ${profile.maxWords} words`);
  }
  const sentences = splitSentences(trimmed);
  if (profile && sentences.length > profile.maxSentences) {
    failedRuleIds.push('max-sentences');
    notes.push(`display text exceeds ${profile.maxSentences} sentences`);
  }
  const masked = maskLockedSpans(trimmed, locks);
  // Fact locks establish provenance, not presentational safety. The one
  // structural colon in deterministic EC copy is not a label; inspect both
  // the remaining full line and each proof field so source text cannot hide
  // directions inside a generated lock.
  let presentationText = trimmed;
  const ecEvent = request.profile === 'ec-warning' ? request.ecWarning?.event : undefined;
  if (ecEvent && presentationText.startsWith(`${ecEvent}:`)) {
    presentationText = `${ecEvent} ${presentationText.slice(ecEvent.length + 1)}`;
  }
  const presentationReasons = new Set(leftoverPresentation(presentationText));
  if (request.profile === 'ec-warning' && request.ecWarning) {
    const fields = [
      request.ecWarning.event,
      request.ecWarning.headline,
      request.ecWarning.timing ?? '',
      ...request.ecWarning.verifiedPlaces,
    ];
    fields.flatMap(leftoverPresentation).forEach((reason) => presentationReasons.add(reason));
  }
  for (const reason of presentationReasons) {
    failedRuleIds.push(reason);
    notes.push(`display text has leftover ${reason}`);
  }
  const firstLine = firstNonEmptyLine(trimmed);
  for (const rule of context.policy.rules) {
    if (rule.type === 'phrase') {
      const hits = findLiteralMatches(trimmed, rule.value, {
        caseSensitive: false,
        boundary: 'both',
      });
      if (hits.length) {
        failedRuleIds.push(rule.id);
        notes.push(`banned phrase ${rule.id}`);
      } else {
        passedRuleIds.push(rule.id);
      }
    } else if (rule.type === 'first-line-opener') {
      if (firstLine && openerHits(firstLine.text, rule.value)) {
        failedRuleIds.push(rule.id);
        notes.push(`banned first-line opener ${rule.id}`);
      } else {
        passedRuleIds.push(rule.id);
      }
    } else if (rule.type === 'sentence-opener') {
      const hit = sentences.some((sentence) => openerHits(sentence.text, rule.value));
      if (hit) {
        failedRuleIds.push(rule.id);
        notes.push(`banned sentence opener ${rule.id}`);
      } else {
        passedRuleIds.push(rule.id);
      }
    } else if (rule.type === 'station-hour-limit') {
      if (rollingWouldExceed(rule, trimmed, context)) {
        failedRuleIds.push(rule.id);
        notes.push(`station-hour limit ${rule.id}`);
      } else {
        passedRuleIds.push(rule.id);
      }
    }
  }
  const cardinality = validateRestoredCardinality(trimmed, locks);
  if (!cardinality.ok) {
    failedRuleIds.push('fact-cardinality');
    notes.push(cardinality.message);
  }
  const newFacts = [
    ...findNewFactualClaims(masked),
    ...findCapitalizedProperNames(masked),
  ];
  if (locks.length > 0 || request.facts.sourceBacked || request.linkContext) {
    if (newFacts.length) {
      failedRuleIds.push('new-facts');
      notes.push(`unlocked factual claim (${newFacts[0].kind})`);
    }
  }
  return {
    failedRuleIds: [...new Set(failedRuleIds)],
    passedRuleIds: [...new Set(passedRuleIds)],
    message: notes[0] ?? '',
  };
}

export function applyReplacements(
  text: string,
  replacements: readonly BroadcastQaReplacement[],
): { text: string; records: TextPolicyReplacement[] } {
  let next = text;
  const records: TextPolicyReplacement[] = [];
  replacements.forEach((rule, index) => {
    if (!rule.match) return;
    const inputTextHash = canonicalSha256(next);
    const matches = findLiteralMatches(next, rule.match, {
      caseSensitive: rule.caseSensitive,
      boundary: rule.boundary,
    });
    if (!matches.length) return;
    const step = index + 1;
    for (const match of matches) {
      records.push({
        ruleId: rule.id,
        step,
        inputTextHash,
        sourceStart: match.start,
        sourceEnd: match.end,
        matchedText: match.text,
        matchedTextHash: canonicalSha256(match.text),
        replacement: rule.replacement,
      });
    }
    for (const match of [...matches].reverse()) {
      next = next.slice(0, match.start) + rule.replacement + next.slice(match.end);
    }
  });
  return { text: next, records };
}

export function speakerPersonaHash(persona: Persona | null | undefined): string {
  const tts = (
    persona?.tts && typeof persona.tts === 'object' && !Array.isArray(persona.tts)
      ? persona.tts
      : {}
  ) as Record<string, unknown>;
  return canonicalSha256({
    id: String(persona?.id ?? ''),
    name: String(persona?.name ?? ''),
    tagline: String(persona?.tagline ?? ''),
    frequency: String(persona?.frequency ?? ''),
    scriptLength: String(persona?.scriptLength ?? ''),
    djMode: persona?.djMode === true,
    language: String(persona?.language ?? ''),
    linkStyle: String(persona?.linkStyle ?? 'natural'),
    humour: typeof persona?.humour === 'number' ? persona.humour : null,
    localColour: typeof persona?.localColour === 'number' ? persona.localColour : null,
    warmth: typeof persona?.warmth === 'number' ? persona.warmth : null,
    soul: String(persona?.soul ?? ''),
    avatar: String(persona?.avatar ?? ''),
    skills: Array.isArray(persona?.skills) ? persona.skills.map(String) : null,
    tags: Array.isArray(persona?.tags) ? persona.tags.map(String) : [],
    tts: {
      engine: String(tts.engine ?? ''),
      cloudProvider: String(tts.cloudProvider ?? ''),
      voice: String(tts.voice ?? ''),
      gainDb: typeof tts.gainDb === 'number' ? tts.gainDb : null,
      speed: typeof tts.speed === 'number' ? tts.speed : null,
    },
  });
}

export function trackMetadataHash(artist: string, title: string): string {
  return canonicalSha256({ artist, title });
}

export function buildTrackLinkLocks(
  artist: string,
  title: string,
  style: 'natural' | 'announce',
): FactLock[] {
  return [
    { id: 'track.artist', displayValue: artist, required: true },
    { id: 'track.title', displayValue: title, required: style === 'natural' },
  ];
}

export function naturalTrackFallback(artist: string, title: string): string {
  return `${artist}, with ${title}.`;
}

export type TrackLinkBuild = {
  context: VoiceLinkContext;
  displayText: string;
  factLocks: FactLock[];
  rewriteAllowed: boolean;
};

export function buildTrackLinkContext(input: {
  speakerPersona: Persona;
  artist: string;
  title: string;
  currentIsOnAir: boolean;
  lastAiredLink: string | null;
}): TrackLinkBuild | { ok: false; message: string } {
  const artist = input.artist.trim();
  const title = input.title.trim();
  if (!artist || !title) return { ok: false, message: 'track link needs artist and title locks' };
  const speakerPersonaId = String(input.speakerPersona.id ?? '').trim();
  if (!speakerPersonaId) {
    return { ok: false, message: 'track link needs a caller-selected persona id' };
  }
  const hash = speakerPersonaHash(input.speakerPersona);
  const metaHash = trackMetadataHash(artist, title);
  if (announceLinks(input.speakerPersona)) {
    const displayText = announceLine(artist, input.speakerPersona, {
      lastLine: input.lastAiredLink,
      currentIsOnAir: input.currentIsOnAir,
    });
    if (!displayText) return { ok: false, message: 'announce-style link could not be composed' };
    const announceForm = input.currentIsOnAir ? 'this-is' : nextAnnounceForm(input.lastAiredLink);
    return {
      context: {
        style: 'announce',
        trackMetadataHash: metaHash,
        artistLockId: 'track.artist',
        titleLockId: 'track.title',
        currentIsOnAir: input.currentIsOnAir,
        speakerPersonaId,
        speakerPersonaHash: hash,
        announceForm,
        lastAiredLinkHash: canonicalSha256(input.lastAiredLink),
      },
      displayText,
      factLocks: buildTrackLinkLocks(artist, title, 'announce'),
      rewriteAllowed: false,
    };
  }
  return {
    context: {
      style: 'natural',
      trackMetadataHash: metaHash,
      artistLockId: 'track.artist',
      titleLockId: 'track.title',
      currentIsOnAir: input.currentIsOnAir,
      speakerPersonaId,
      speakerPersonaHash: hash,
    },
    displayText: naturalTrackFallback(artist, title),
    factLocks: buildTrackLinkLocks(artist, title, 'natural'),
    rewriteAllowed: true,
  };
}

function lockById(locks: readonly FactLock[], id: string): FactLock | undefined {
  return locks.find((lock) => lock.id === id);
}

function announceLineFor(request: VoiceRenderRequest, artist: string): string {
  const link = request.linkContext;
  if (!link || link.style !== 'announce') return '';
  if (link.currentIsOnAir || link.announceForm === 'this-is') return `This is ${artist}.`;
  return `Next up, ${artist}.`;
}

function ecWarningLocks(proof: EcWarningCopyProof, lease: ProvenanceLease): FactLock[] {
  const source = {
    sourceRef: lease.sourceRef,
    sourceRevision: lease.sourceRevision,
  };
  const locks: FactLock[] = [
    { id: 'ec.event', displayValue: proof.event, required: true, ...source },
    { id: 'ec.headline', displayValue: proof.headline, required: true, ...source },
    { id: 'ec.url', displayValue: 'weather.gc.ca', required: true, ...source },
  ];
  proof.verifiedPlaces.forEach((place, i) => {
    locks.push({ id: `ec.place.${i + 1}`, displayValue: place, required: true, ...source });
  });
  if (proof.timing) {
    locks.push({ id: 'ec.timing', displayValue: proof.timing, required: false, ...source });
  }
  return locks;
}

const NATURAL_ARTIST_SLOT = '[[TRACK_ARTIST]]';
const NATURAL_TITLE_SLOT = '[[TRACK_TITLE]]';
const NATURAL_TRACK_SHAPES = new Set([
  `${NATURAL_ARTIST_SLOT}, with ${NATURAL_TITLE_SLOT}.`,
  `${NATURAL_ARTIST_SLOT} with ${NATURAL_TITLE_SLOT} over the air.`,
  `A good tune from ${NATURAL_ARTIST_SLOT}, with ${NATURAL_TITLE_SLOT}.`,
  `Here's ${NATURAL_ARTIST_SLOT}, with ${NATURAL_TITLE_SLOT}.`,
  `Some music from ${NATURAL_ARTIST_SLOT}, with ${NATURAL_TITLE_SLOT}.`,
]);

function naturalTrackShape(
  text: string,
  artist: FactLock,
  title: FactLock,
): string | null {
  const tokenized = tokenizeFactLocks(text, [artist, title]);
  if (!('tokens' in tokenized)) return null;
  let shape = tokenized.text;
  for (const token of tokenized.tokens) {
    const slot = token.lock.id === artist.id ? NATURAL_ARTIST_SLOT : NATURAL_TITLE_SLOT;
    shape = shape.replace(token.token, slot);
  }
  return shape;
}

function checkTrackLink(
  text: string,
  request: VoiceRenderRequest,
  locks: readonly FactLock[],
): { ok: true } | { ok: false; kind: 'announce' | 'natural'; message: string; failedRuleIds: string[] } {
  const link = request.linkContext;
  if (!link) return { ok: true };
  const derivedStyle = announceLinks(request.persona) ? 'announce' : 'natural';
  if (link.style !== derivedStyle) {
    return {
      ok: false,
      kind: derivedStyle,
      message: 'linkContext.style must come from announceLinks(persona)',
      failedRuleIds: ['link-style'],
    };
  }
  const speaker = request.persona ?? null;
  if (
    !link.speakerPersonaId
    || !speaker?.id
    || speaker.id !== link.speakerPersonaId
    || speakerPersonaHash(speaker) !== link.speakerPersonaHash
  ) {
    return {
      ok: false,
      kind: link.style,
      message: 'linkContext speaker does not match the caller-selected persona',
      failedRuleIds: ['link-speaker'],
    };
  }
  const artist = lockById(locks, link.artistLockId);
  const title = lockById(locks, link.titleLockId);
  if (!artist || !title) {
    return {
      ok: false,
      kind: link.style,
      message: 'track link is missing artist or title locks',
      failedRuleIds: ['link-locks'],
    };
  }
  const lockShapeOk = link.style === 'announce'
    ? artist.required === true && title.required === false
    : artist.required === true && title.required === true;
  if (!lockShapeOk) {
    return {
      ok: false,
      kind: link.style,
      message: link.style === 'announce'
        ? 'announce links require the artist and keep the title optional'
        : 'natural links require both artist and title',
      failedRuleIds: ['link-locks'],
    };
  }
  if (trackMetadataHash(artist.displayValue, title.displayValue) !== link.trackMetadataHash) {
    return {
      ok: false,
      kind: link.style,
      message: 'track metadata hash does not match the locked artist and title',
      failedRuleIds: ['link-metadata'],
    };
  }
  if (link.style === 'announce') {
    if (link.currentIsOnAir && link.announceForm !== 'this-is') {
      return {
        ok: false,
        kind: 'announce',
        message: 'current-track announce form must be This is',
        failedRuleIds: ['link-form'],
      };
    }
    const expected = announceLineFor(request, artist.displayValue);
    if (!expected || text.trim() !== expected) {
      return {
        ok: false,
        kind: 'announce',
        message: 'announce-style line must be exactly This is <artist>. or Next up, <artist>.',
        failedRuleIds: ['link-announce'],
      };
    }
    return { ok: true };
  }
  const shape = naturalTrackShape(text, artist, title);
  if (!shape || !NATURAL_TRACK_SHAPES.has(shape)) {
    return {
      ok: false,
      kind: 'natural',
      message: 'natural track link is outside the approved metadata-only forms',
      failedRuleIds: ['link-form'],
    };
  }
  return { ok: true };
}

function fail(
  code: VoiceRejectCode,
  stage: VoiceQaStage,
  message: string,
  failedRuleIds: string[],
  replacements: TextPolicyReplacement[],
): TextPolicyFailure {
  return { ok: false, code, stage, message, failedRuleIds, replacements };
}

function normalizeSpeechPreservingFactTokens(
  text: string,
  tokens: readonly FactToken[],
  corrections: readonly SpeechCorrection[],
): { ok: true; text: string } | { ok: false; message: string } {
  const spans = tokens
    .map((token) => ({ token, start: text.indexOf(token.token) }))
    .filter((row) => row.start >= 0)
    .sort((a, b) => a.start - b.start);
  let corrected = '';
  let cursor = 0;
  for (const span of spans) {
    corrected += applySpeechCorrections(text.slice(cursor, span.start), corrections);
    corrected += span.token.token;
    cursor = span.start + span.token.token.length;
  }
  corrected += applySpeechCorrections(text.slice(cursor), corrections);
  // Built-in symbol/markup normalization now runs once over the reconstructed
  // line, but operator corrections never see, target, or reorder fact tokens.
  const normalized = normalizeForSpeech(corrected, []);
  const preservation = validatePreservedFactTokens(text, normalized, tokens);
  return preservation.ok ? { ok: true, text: normalized } : preservation;
}

type ParsedFacts = {
  sourceBacked: boolean;
  factLocks: FactLock[];
  provenance?: ProvenanceLease;
};

function parseRuntimeFacts(raw: unknown): { ok: true; facts: ParsedFacts } | { ok: false; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'voice facts must be an object' };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.sourceBacked !== 'boolean' || !Array.isArray(rec.factLocks)) {
    return { ok: false, message: 'voice facts need sourceBacked and factLocks' };
  }
  const allowed = rec.sourceBacked
    ? new Set(['sourceBacked', 'factLocks', 'provenance'])
    : new Set(['sourceBacked', 'factLocks']);
  const unknown = Object.keys(rec).find((key) => !allowed.has(key));
  if (unknown) return { ok: false, message: `voice facts has unknown field "${unknown}"` };
  const factLocks: FactLock[] = [];
  for (const item of rec.factLocks) {
    const parsed = factLockSchema.safeParse(item);
    if (!parsed.success) {
      return { ok: false, message: `invalid fact lock: ${parsed.error.issues[0]?.message ?? 'invalid value'}` };
    }
    factLocks.push(parsed.data);
  }
  if (!rec.sourceBacked) {
    if (factLocks.some((lock) => lock.sourceRef !== undefined || lock.sourceRevision !== undefined)) {
      return { ok: false, message: 'non-source-backed facts cannot carry source bindings' };
    }
    return { ok: true, facts: { sourceBacked: false, factLocks } };
  }
  const provenance = provenanceLeaseSchema.safeParse(rec.provenance);
  if (!provenance.success) {
    return { ok: false, message: `invalid source provenance: ${provenance.error.issues[0]?.message ?? 'invalid value'}` };
  }
  return {
    ok: true,
    facts: { sourceBacked: true, factLocks, provenance: provenance.data },
  };
}

function validateSourceBindings(
  text: string,
  locks: readonly FactLock[],
  lease: ProvenanceLease,
  verifiedTemplateWords: readonly string[] = [],
): { ok: true } | { ok: false; message: string } {
  if (!locks.length) return { ok: false, message: 'source-backed speech requires source-bound fact locks' };
  if (!locks.some((lock) => lock.required)) {
    return { ok: false, message: 'source-backed speech requires a present required fact lock' };
  }
  if (
    verifiedTemplateWords.length === 0
    && !locks.some((lock) => lock.required && lock.displayValue === text)
  ) {
    return {
      ok: false,
      message: 'source-backed speech requires a required full-copy source lock',
    };
  }
  for (const lock of locks) {
    if (lock.sourceRef !== lease.sourceRef || lock.sourceRevision !== lease.sourceRevision) {
      return {
        ok: false,
        message: `fact lock ${lock.id} does not match the provenance source and revision`,
      };
    }
  }
  const allocation = allocateFactLockSpans(text, locks);
  if (!allocation.ok) {
    return { ok: false, message: `source-backed speech has incomplete locks: ${allocation.message}` };
  }
  const unlocked = findUnlockedSourceWords(
    maskLockedSpans(text, locks),
    verifiedTemplateWords,
  );
  if (unlocked.length) {
    return {
      ok: false,
      message: `source-backed speech has unlocked assertion word "${unlocked[0]}"`,
    };
  }
  return { ok: true };
}

export async function runTextPolicy(
  request: VoiceRenderRequest,
  context: TextPolicyContext,
): Promise<TextPolicySuccess | TextPolicyFailure> {
  const replacements: TextPolicyReplacement[] = [];
  const profile = durationProfileFor(request.profile);
  if (!profile) {
    return fail('unsupported_profile', 'text-policy', `unsupported duration profile ${request.profile}`, [], []);
  }
  if (request.rewriteCount !== 0 && request.rewriteCount !== 1) {
    return fail('text_policy_failed', 'text-policy', 'rewriteCount must be zero or one', ['rewrite-count'], []);
  }
  const parsedFacts = parseRuntimeFacts(request.facts);
  if (!parsedFacts.ok) {
    return fail('fact_lock_failed', 'text-policy', parsedFacts.message, ['fact-shape'], []);
  }
  let locks = parsedFacts.facts.factLocks;
  const ids = validateFactLockIds(locks);
  if (!ids.ok) return fail('fact_lock_failed', 'text-policy', ids.message, ['fact-id'], []);

  const lease = parsedFacts.facts.provenance;
  if (parsedFacts.facts.sourceBacked && lease) {
    const fetched = Date.parse(lease.fetchedAt);
    const expires = Date.parse(lease.expiresAt);
    if (
      !Number.isFinite(fetched)
      || !Number.isFinite(expires)
      || fetched > context.nowMs
      || expires <= fetched
    ) {
      return fail('fact_lock_failed', 'text-policy', 'source provenance has invalid timestamps', ['provenance'], []);
    }
    if (expires <= context.nowMs) {
      return fail('source_stale', 'text-policy', 'source provenance has expired', ['provenance'], []);
    }
  }

  let rewriteAllowed = request.rewriteAllowed && request.rewriteCount === 0 && !parsedFacts.facts.sourceBacked;
  let text = stripThinking(request.displayText ?? '');
  text = normalizeForDisplay(text);
  let ecProof: EcWarningCopyProof | null = null;

  if (request.profile === 'ec-warning' && !request.ecWarning) {
    return fail('text_policy_failed', 'text-policy', 'ec-warning profile requires a copy proof', ['ec-warning'], []);
  }
  if (request.ecWarning) {
    if (request.profile !== 'ec-warning' || !parsedFacts.facts.sourceBacked || !lease) {
      return fail(
        'fact_lock_failed',
        'text-policy',
        'EC warning copy must use the source-backed ec-warning profile',
        ['ec-warning', 'provenance'],
        [],
      );
    }
    const parsedProof = ecWarningCopyProofSchema.safeParse(request.ecWarning);
    if (!parsedProof.success) {
      return fail(
        'text_policy_failed',
        'text-policy',
        `invalid EC warning proof: ${parsedProof.error.issues[0]?.message ?? 'invalid value'}`,
        ['ec-warning'],
        [],
      );
    }
    ecProof = parsedProof.data;
    if (
      ecProof.alertReference !== lease.sourceRef
      || ecProof.alertRevision !== lease.sourceRevision
    ) {
      return fail(
        'fact_lock_failed',
        'text-policy',
        'EC warning proof does not match the provenance source and revision',
        ['ec-warning', 'provenance'],
        [],
      );
    }
    const selected = selectEcWarningDisplay(
      ecProof,
      profile.maxWords,
    );
    if (!selected.ok) {
      return fail('text_policy_failed', 'text-policy', selected.message, ['ec-warning'], []);
    }
    text = selected.displayText;
    rewriteAllowed = false;
    locks = [...locks, ...ecWarningLocks(ecProof, lease)];
    const mergedIds = validateFactLockIds(locks);
    if (!mergedIds.ok) return fail('fact_lock_failed', 'text-policy', mergedIds.message, ['fact-id'], []);
  }

  if (parsedFacts.facts.sourceBacked && lease) {
    const binding = validateSourceBindings(
      text,
      locks,
      lease,
      ecProof ? ['affecting', 'covering', 'details'] : [],
    );
    if (!binding.ok) {
      return fail('fact_lock_failed', 'text-policy', binding.message, ['provenance'], []);
    }
  }

  const applied = applyReplacements(text, context.policy.replacements);
  text = applied.text;
  replacements.push(...applied.records);
  if (parsedFacts.facts.sourceBacked && lease) {
    const binding = validateSourceBindings(
      text,
      locks,
      lease,
      ecProof ? ['affecting', 'covering', 'details'] : [],
    );
    if (!binding.ok) {
      return fail('fact_lock_failed', 'text-policy', binding.message, ['provenance'], replacements);
    }
  }
  // Configured replacements are reviewed station policy. Their result is the
  // factual baseline the optional model rewrite may remove from, but never add
  // to.
  let factualBaseline = maskLockedSpans(text, locks);

  let track = checkTrackLink(text, request, locks);
  let display = checkDisplayText(text, request, context, locks);
  let rewriteCount: 0 | 1 = request.rewriteCount;

  // Announce copy is fixed, so any mismatch is terminal. A natural link first
  // receives the same unified validation as every other line; only then may
  // its constrained-form failure fall back to the deterministic front announce.
  if (!track.ok && track.kind === 'announce') {
    return fail('text_policy_failed', 'text-policy', track.message, track.failedRuleIds, replacements);
  }
  if (!track.ok && track.kind === 'natural') {
    const artist = lockById(locks, request.linkContext!.artistLockId);
    const title = lockById(locks, request.linkContext!.titleLockId);
    if (artist && title) {
      text = naturalTrackFallback(artist.displayValue, title.displayValue);
      track = checkTrackLink(text, request, locks);
      display = checkDisplayText(text, request, context, locks);
    }
  }

  if ((!display.failedRuleIds.length && track.ok) === false) {
    const canRewrite = rewriteAllowed && (!request.linkContext || request.linkContext.style === 'natural');
    if (!canRewrite) {
      const message = !track.ok ? track.message : display.message;
      const code = display.failedRuleIds.includes('fact-cardinality') ? 'fact_lock_failed' : 'text_policy_failed';
      return fail(code, 'text-policy', message || 'display text failed policy', [
        ...(!track.ok ? track.failedRuleIds : []),
        ...display.failedRuleIds,
      ], replacements);
    }
    const tokenized = tokenizeFactLocks(text, locks);
    if (!('tokens' in tokenized)) {
      return fail('fact_lock_failed', 'rewrite', tokenized.message, ['fact-id'], replacements);
    }
    const rewriteFailures = [...new Set([
      ...(!track.ok ? track.failedRuleIds : []),
      ...display.failedRuleIds,
    ])];
    let rewritten = '';
    try {
      rewritten = await rewriteDisplayText({
        tokenizedText: tokenized.text,
        failedRuleIds: rewriteFailures,
        rewriteFn: context.rewriteFn,
      });
    } catch (err) {
      return fail(
        'text_policy_failed',
        'rewrite',
        err instanceof Error ? err.message : 'rewrite failed',
        display.failedRuleIds,
        replacements,
      );
    }
    rewriteCount = 1;
    if (!rewritten) {
      return fail('text_policy_failed', 'rewrite', 'rewrite returned empty copy', display.failedRuleIds, replacements);
    }
    const failedSet = new Set(rewriteFailures);
    const removableLeadingPhrases = context.policy.rules
      .filter((rule) => (
        failedSet.has(rule.id)
        && (rule.type === 'first-line-opener' || rule.type === 'sentence-opener')
      ))
      .map((rule) => rule.value);
    const tokenStructure = validateRewriteTokens(rewritten, tokenized.tokens, {
      sourceText: tokenized.text,
      removableLeadingPhrases,
    });
    if (!tokenStructure.ok) {
      return fail(
        'fact_lock_failed',
        'rewrite',
        tokenStructure.message,
        [...new Set([
          ...rewriteFailures,
          'rewrite-structure',
          'new-facts',
          ...(tokenized.tokens.length ? ['fact-token'] : []),
        ])],
        replacements,
      );
    }
    const restoredComparison = restoreFactLocks(
      tokenStructure.comparisonText,
      tokenized.tokens,
    );
    if (!restoredComparison.ok) {
      return fail(
        'fact_lock_failed',
        'rewrite',
        restoredComparison.message,
        ['fact-token'],
        replacements,
      );
    }
    factualBaseline = maskLockedSpans(
      normalizeForDisplay(restoredComparison.text),
      locks,
    );
    const restored = restoreFactLocks(rewritten, tokenized.tokens);
    if (!restored.ok) {
      return fail('fact_lock_failed', 'rewrite', restored.message, ['fact-token'], replacements);
    }
    text = normalizeForDisplay(restored.text);
    track = checkTrackLink(text, request, locks);
    display = checkDisplayText(text, request, context, locks);
    if (!track.ok || display.failedRuleIds.length) {
      const message = !track.ok ? track.message : display.message;
      const code = display.failedRuleIds.includes('fact-cardinality') ? 'fact_lock_failed' : 'text_policy_failed';
      return fail(code, 'rewrite', message || 'rewrite remained invalid', [
        ...(!track.ok ? track.failedRuleIds : []),
        ...display.failedRuleIds,
      ], replacements);
    }
  }

  const addedFacts = addedFactualClaims(
    factualBaseline,
    maskLockedSpans(text, locks),
  );
  if (addedFacts.length) {
    return fail(
      'fact_lock_failed',
      rewriteCount > request.rewriteCount ? 'rewrite' : 'text-policy',
      `copy added an unlocked factual claim (${addedFacts[0].kind}: ${addedFacts[0].text})`,
      ['new-facts'],
      replacements,
    );
  }

  if (
    ecProof
    && hashEcWarningText(text) !== ecProof.fullTextHash
    && hashEcWarningText(text) !== ecProof.mandatoryTextHash
  ) {
    return fail(
      'fact_lock_failed',
      'text-policy',
      'final EC warning copy no longer matches an approved proof hash',
      ['ec-warning-final'],
      replacements,
    );
  }

  // Keep opaque tokens in place while pronunciation corrections run. Restoring
  // afterwards prevents a correction from moving an approved spelling to a
  // different source span; the final cardinality pass catches inserted copies.
  const spokenTokenized = tokenizeFactLocks(text, locks);
  if (!('tokens' in spokenTokenized)) {
    return fail('fact_lock_failed', 'text-policy', spokenTokenized.message, ['spoken-fact'], replacements);
  }
  const baselineNormalized = normalizeSpeechPreservingFactTokens(
    spokenTokenized.text,
    spokenTokenized.tokens,
    [],
  );
  if (!baselineNormalized.ok) {
    return fail('fact_lock_failed', 'text-policy', baselineNormalized.message, ['spoken-fact'], replacements);
  }
  const baselineRestored = restoreSpokenFactLocks(baselineNormalized.text, spokenTokenized.tokens);
  if (!baselineRestored.ok) {
    return fail('fact_lock_failed', 'text-policy', baselineRestored.message, ['spoken-fact'], replacements);
  }
  const baselineSpoken = scrubCjkForSpeech(
    baselineRestored.text,
    request.persona?.language,
  );
  const speechNormalized = normalizeSpeechPreservingFactTokens(
    spokenTokenized.text,
    spokenTokenized.tokens,
    context.corrections,
  );
  if (!speechNormalized.ok) {
    return fail('fact_lock_failed', 'text-policy', speechNormalized.message, ['spoken-fact'], replacements);
  }
  const restoredSpoken = restoreSpokenFactLocks(speechNormalized.text, spokenTokenized.tokens);
  if (!restoredSpoken.ok) {
    return fail('fact_lock_failed', 'text-policy', restoredSpoken.message, ['spoken-fact'], replacements);
  }
  const spoken = scrubCjkForSpeech(
    restoredSpoken.text,
    request.persona?.language,
  );
  if (!spoken.trim()) {
    return fail('text_policy_failed', 'text-policy', 'spoken text is empty', ['empty-spoken'], replacements);
  }
  const spokenLocks = validateSpokenLocks(spoken, locks);
  if (!spokenLocks.ok) {
    return fail('fact_lock_failed', 'text-policy', spokenLocks.message, ['spoken-fact'], replacements);
  }
  const spokenFactLocks = locks.map((lock) => ({
    ...lock,
    displayValue: spokenLockExpected(lock),
  }));
  if (
    (parsedFacts.facts.sourceBacked || request.linkContext)
    && spoken !== baselineSpoken
  ) {
    return fail(
      'fact_lock_failed',
      'text-policy',
      'speech correction changed source-backed or metadata-bound copy',
      ['spoken-policy'],
      replacements,
    );
  }
  const spokenDisplay = checkDisplayText(spoken, request, context, spokenFactLocks);
  if (spokenDisplay.failedRuleIds.length) {
    return fail(
      spokenDisplay.failedRuleIds.includes('fact-cardinality')
        ? 'fact_lock_failed'
        : 'text_policy_failed',
      'text-policy',
      spokenDisplay.message || 'spoken text failed policy',
      spokenDisplay.failedRuleIds,
      replacements,
    );
  }
  const spokenAddedFacts = addedFactualClaims(
    maskLockedSpans(baselineSpoken, spokenFactLocks),
    maskLockedSpans(spoken, spokenFactLocks),
  );
  if (spokenAddedFacts.length) {
    return fail(
      'fact_lock_failed',
      'text-policy',
      `speech correction added an unlocked factual claim (${spokenAddedFacts[0].kind}: ${spokenAddedFacts[0].text})`,
      ['spoken-fact'],
      replacements,
    );
  }

  return {
    ok: true,
    displayText: text,
    spokenText: spoken,
    rewriteCount,
    replacements,
    passedRuleIds: display.passedRuleIds,
    failedRuleIds: [],
    factLocksHash: factLocksHash(locks),
  };
}
