// Opaque fact tokens and post-restore cardinality. Display spelling is never
// rewritten to make a lock easier to match — longest exact values are replaced
// first so a nested town cannot consume a larger place name.

import { VOICE_FACT_LOCK_ID_RE, type FactLock } from '../../schemas/voice.js';
import { canonicalSha256 } from '../../util/canonical-json.js';

export const FACT_TOKEN_RE = /\[\[FACT_(\d+)_([0-9a-f]{8})\]\]/g;

export type FactToken = {
  index: number;
  hash8: string;
  token: string;
  lock: FactLock;
  sourceOrder: number | null;
};

export type FactLockFailure = {
  ok: false;
  message: string;
};

export function factLocksHash(locks: readonly FactLock[]): string {
  return canonicalSha256(locks);
}

export function factLockHash8(lock: Pick<FactLock, 'id' | 'displayValue'>): string {
  return canonicalSha256({ id: lock.id, displayValue: lock.displayValue }).slice(0, 8);
}

export function validateFactLockIds(locks: readonly FactLock[]): { ok: true } | FactLockFailure {
  const seen = new Set<string>();
  for (const lock of locks) {
    if (!VOICE_FACT_LOCK_ID_RE.test(lock.id)) {
      return { ok: false, message: `invalid fact lock id: ${lock.id}` };
    }
    if (seen.has(lock.id)) {
      return { ok: false, message: `duplicate fact lock id: ${lock.id}` };
    }
    seen.add(lock.id);
    if (!lock.displayValue) {
      return { ok: false, message: `empty display value for fact lock ${lock.id}` };
    }
  }
  return { ok: true };
}

export function sortLocksLongestFirst(locks: readonly FactLock[]): FactLock[] {
  return locks
    .map((lock, order) => ({ lock, order }))
    .sort((a, b) => {
      const byLen = b.lock.displayValue.normalize('NFKC').length
        - a.lock.displayValue.normalize('NFKC').length;
      return byLen !== 0 ? byLen : a.order - b.order;
    })
    .map((row) => row.lock);
}

export type LiteralBoundary = 'none' | 'start' | 'end' | 'both';
export type SourceSpan = { start: number; end: number; text: string };

type NormStream = { norm: string; originStart: number[]; originEnd: number[] };
type LiteralMatchOptions = {
  caseSensitive: boolean;
  boundary: LiteralBoundary;
  punctuation?: 'space' | 'preserve';
};

const MATCH_WORD_CHAR = /\p{L}|\p{M}|\p{N}/u;
const MATCH_PUNCT_CHAR = /\p{P}/u;

function unicodeCaseFold(text: string): string {
  // Upper/lower cycling supplies Unicode's one-to-many equivalences (sharp s,
  // ligatures, sigma variants, and compatibility letters). Preserve dotless ı,
  // whose default case fold intentionally differs from ASCII i, then decompose
  // so precomposed and combining-mark spellings share one match form.
  return graphemeSegments(text.normalize('NFKD'))
    .map(({ segment }) => (
      segment.startsWith('ı')
        ? segment
        : segment.toLocaleUpperCase('und').toLocaleLowerCase('und')
    ))
    .join('')
    .replaceAll('ß', 'ss')
    .replaceAll('ς', 'σ')
    .replaceAll('ſ', 's')
    .normalize('NFKD');
}

function graphemeSegments(text: string): Array<{ segment: string; start: number; end: number }> {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (
      locales?: string | string[],
      options?: { granularity: 'grapheme' },
    ) => { segment(input: string): Iterable<{ segment: string; index: number }> };
  }).Segmenter;
  if (Segmenter) {
    return [...new Segmenter('und', { granularity: 'grapheme' }).segment(text)]
      .map(({ segment, index }) => ({ segment, start: index, end: index + segment.length }));
  }
  const out: Array<{ segment: string; start: number; end: number }> = [];
  for (let start = 0; start < text.length; ) {
    const cp = text.codePointAt(start)!;
    const segment = String.fromCodePoint(cp);
    const end = start + segment.length;
    out.push({ segment, start, end });
    start = end;
  }
  return out;
}

function explodeForMatch(
  text: string,
  caseSensitive: boolean,
  punctuation: 'space' | 'preserve',
): NormStream {
  const wholeNfkc = text.normalize('NFKC');
  const segments = graphemeSegments(text);
  const segmentedNfkc = segments.map(({ segment }) => segment.normalize('NFKC')).join('');
  // Grapheme boundaries are normalization-safe. Keep an explicit guard so a
  // future runtime with a broken segmenter fails closed instead of returning
  // plausible but wrong source offsets.
  if (segmentedNfkc !== wholeNfkc) {
    throw new Error('unicode span mapping crossed a normalization boundary');
  }
  const originStart: number[] = [];
  const originEnd: number[] = [];
  let norm = '';
  for (const source of segments) {
    const nfkc = source.segment.normalize('NFKC');
    const folded = caseSensitive ? nfkc : unicodeCaseFold(nfkc);
    for (const ch of folded) {
      const mapped = punctuation === 'space' && MATCH_PUNCT_CHAR.test(ch) ? ' ' : ch;
      if (/\s/u.test(mapped)) {
        if (!norm || norm.endsWith(' ')) {
          if (norm.endsWith(' ')) originEnd[originEnd.length - 1] = source.end;
          continue;
        }
        norm += ' ';
        originStart.push(source.start);
        originEnd.push(source.end);
        continue;
      }
      norm += mapped;
      // `norm` is indexed in UTF-16 code units by indexOf(). Every code unit,
      // including both halves of an astral character or a case-fold expansion,
      // needs an origin entry.
      for (let i = 0; i < mapped.length; i++) {
        originStart.push(source.start);
        originEnd.push(source.end);
      }
    }
  }
  if (norm.endsWith(' ')) {
    norm = norm.slice(0, -1);
    originStart.pop();
    originEnd.pop();
  }
  return { norm, originStart, originEnd };
}

function isWordCharAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  return MATCH_WORD_CHAR.test(String.fromCodePoint(text.codePointAt(index)!));
}

function codeUnitBefore(text: string, index: number): number {
  if (index <= 0) return -1;
  const prev = text.charCodeAt(index - 1);
  if (prev >= 0xDC00 && prev <= 0xDFFF && index >= 2) {
    const hi = text.charCodeAt(index - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return index - 2;
  }
  return index - 1;
}

function boundaryOk(text: string, start: number, end: number, boundary: LiteralBoundary): boolean {
  const startOk = !isWordCharAt(text, codeUnitBefore(text, start));
  const endOk = !isWordCharAt(text, end);
  if (boundary === 'start') return startOk;
  if (boundary === 'end') return endOk;
  if (boundary === 'both') return startOk && endOk;
  return true;
}

function streamLiteralMatches(
  haystack: string,
  needleNorm: string,
  stream: NormStream,
  boundary: LiteralBoundary,
): SourceSpan[] {
  if (!needleNorm) return [];
  const out: SourceSpan[] = [];
  let from = 0;
  while (from <= stream.norm.length - needleNorm.length) {
    const at = stream.norm.indexOf(needleNorm, from);
    if (at < 0) break;
    const finalUnit = at + needleNorm.length - 1;
    const start = stream.originStart[at];
    const end = stream.originEnd[finalUnit];
    const startsInsideExpansion = (
      at > 0
      && stream.originStart[at - 1] === start
      && stream.originEnd[at - 1] === end
    );
    const endsInsideExpansion = (
      finalUnit + 1 < stream.originStart.length
      && stream.originStart[finalUnit + 1] === start
      && stream.originEnd[finalUnit + 1] === end
    );
    if (
      start !== undefined
      && end !== undefined
      && !startsInsideExpansion
      && !endsInsideExpansion
      && boundaryOk(haystack, start, end, boundary)
    ) {
      const candidate = { start, end, text: haystack.slice(start, end) };
      if (out.every((prior) => !overlaps(candidate, prior))) out.push(candidate);
    }
    from = at + Math.max(1, needleNorm.length);
  }
  return out;
}

export function findLiteralMatches(
  haystack: string,
  needle: string,
  opts: LiteralMatchOptions,
): SourceSpan[] {
  if (!needle) return [];
  const punctuation = opts.punctuation ?? 'space';
  const needleStream = explodeForMatch(needle, opts.caseSensitive, punctuation);
  const needleNorm = needleStream.norm.trim();
  if (!needleNorm) {
    const exactNeedle = explodeForMatch(needle, opts.caseSensitive, 'preserve').norm;
    const exactStream = explodeForMatch(haystack, opts.caseSensitive, 'preserve');
    return streamLiteralMatches(haystack, exactNeedle, exactStream, opts.boundary);
  }
  const stream = explodeForMatch(haystack, opts.caseSensitive, punctuation);
  return streamLiteralMatches(haystack, needleNorm, stream, opts.boundary);
}

type AllocatedFactSpan = SourceSpan & { lock: FactLock };
type FactSpanAllocation = { ok: true; spans: AllocatedFactSpan[] } | FactLockFailure;

function overlaps(a: SourceSpan, b: SourceSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

export function allocateFactLockSpans(
  text: string,
  locks: readonly FactLock[],
  spoken = false,
): FactSpanAllocation {
  const ids = validateFactLockIds(locks);
  if (!ids.ok) return ids;
  const ordered = sortLocksLongestFirst(locks);
  const groups = new Map<string, FactLock[]>();
  for (const lock of ordered) {
    const value = spoken ? spokenLockExpected(lock) : lock.displayValue;
    const key = explodeForMatch(value, true, 'preserve').norm;
    const group = groups.get(key) ?? [];
    group.push(lock);
    groups.set(key, group);
  }
  const spans: AllocatedFactSpan[] = [];
  for (const group of groups.values()) {
    const value = spoken ? spokenLockExpected(group[0]) : group[0].displayValue;
    const candidates = findLiteralMatches(text, value, {
      caseSensitive: true,
      boundary: 'both',
      punctuation: 'preserve',
    }).filter((candidate) => spans.every((used) => !overlaps(candidate, used)));
    const required = group.filter((lock) => lock.required);
    const optional = group.filter((lock) => !lock.required);
    if (candidates.length < required.length) {
      const lock = required[candidates.length] ?? required[0];
      return { ok: false, message: `missing required fact ${lock.id}` };
    }
    if (candidates.length > group.length) {
      const lock = optional[0] ?? required[0];
      return {
        ok: false,
        message: lock.required
          ? `duplicated required fact ${lock.id}`
          : `duplicated optional fact ${lock.id}`,
      };
    }
    const rows = [...required, ...optional];
    candidates.forEach((candidate, index) => {
      spans.push({ ...candidate, lock: rows[index] });
    });
  }
  return { ok: true, spans: spans.sort((a, b) => a.start - b.start) };
}

export function tokenizeFactLocks(
  text: string,
  locks: readonly FactLock[],
): { text: string; tokens: FactToken[] } | FactLockFailure {
  const allocation = allocateFactLockSpans(text, locks);
  if (!allocation.ok) return allocation;
  const ordered = sortLocksLongestFirst(locks);
  const sourceOrder = new Map(
    allocation.spans.map((span, index) => [span.lock.id, index]),
  );
  const tokens: FactToken[] = ordered.map((lock, index) => {
    const hash8 = factLockHash8(lock);
    return {
      index,
      hash8,
      token: `[[FACT_${index}_${hash8}]]`,
      lock,
      sourceOrder: sourceOrder.get(lock.id) ?? null,
    };
  });
  const byId = new Map(tokens.map((token) => [token.lock.id, token]));
  let next = text;
  for (const span of [...allocation.spans].sort((a, b) => b.start - a.start)) {
    const token = byId.get(span.lock.id)!;
    next = next.slice(0, span.start) + token.token + next.slice(span.end);
  }
  return { text: next, tokens };
}

export function listRewriteTokens(
  text: string,
): Array<{ index: number; hash8: string; token: string; start: number; end: number }> {
  const found: Array<{
    index: number;
    hash8: string;
    token: string;
    start: number;
    end: number;
  }> = [];
  const re = new RegExp(FACT_TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    found.push({
      index: Number(m[1]),
      hash8: m[2],
      token: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return found;
}

type RewriteTokenValidationOptions = {
  sourceText: string;
  removableLeadingPhrases?: readonly string[];
};

function canonicalConnector(text: string): string {
  return unicodeCaseFold(text.normalize('NFKC')).replace(/\s+/gu, ' ').trim();
}

const SAFE_REMOVABLE_OPENERS = new Set(['anyway', 'ok', 'okay', 'so', 'well']);

function rewriteLexicalSkeleton(text: string): string {
  return unicodeCaseFold(text.normalize('NFKC'))
    .replaceAll('’', "'")
    .replace(/\s+/gu, ' ')
    .trim();
}

function removeSafeLeadingPhrase(text: string, phrase: string): string | null {
  if (!SAFE_REMOVABLE_OPENERS.has(rewriteLexicalSkeleton(phrase))) {
    return null;
  }
  const match = findLiteralMatches(text, phrase, {
    caseSensitive: false,
    boundary: 'both',
    punctuation: 'preserve',
  })[0];
  if (!match || !/^[\s"'“”‘’([{]*$/u.test(text.slice(0, match.start))) return null;
  const matched = text.slice(match.start, match.end);
  const after = text.slice(match.end);
  const commaPunctuated = /[,;:]\s*$/u.test(matched) || /^\s*[,;:]/u.test(after);
  const dashPunctuated = /[—–-]\s+$/u.test(matched) || /^\s*[—–-]\s+/u.test(after);
  if (!commaPunctuated && !dashPunctuated) return null;
  let remaining = after;
  if (/[,;:]\s*$/u.test(matched) || /[—–-]\s+$/u.test(matched)) {
    remaining = after.replace(/^\s*/u, '');
  } else if (commaPunctuated) {
    remaining = after.replace(/^\s*[,;:]\s*/u, '');
  } else {
    remaining = after.replace(/^\s*[—–-]\s+/u, '');
  }
  return text.slice(0, match.start) + remaining;
}

function allowedLeadingConnectors(
  sourcePrefix: string,
  removablePhrases: readonly string[],
): Set<string> {
  const allowed = new Set([canonicalConnector(sourcePrefix)]);
  for (const phrase of removablePhrases) {
    const remaining = removeSafeLeadingPhrase(sourcePrefix, phrase);
    if (remaining !== null) allowed.add(canonicalConnector(remaining));
  }
  return allowed;
}

export function validateRewriteTokens(
  rewritten: string,
  tokens: readonly FactToken[],
  options?: RewriteTokenValidationOptions,
): { ok: true; comparisonText: string } | FactLockFailure {
  const expected = new Map(tokens.map((token) => [token.token, token]));
  const counts = new Map<string, number>();
  const foundTokens = listRewriteTokens(rewritten);
  for (const found of foundTokens) {
    const token = expected.get(found.token);
    if (!token) {
      return { ok: false, message: `unknown or changed fact token ${found.token}` };
    }
    counts.set(found.token, (counts.get(found.token) ?? 0) + 1);
  }
  for (const token of tokens) {
    const n = counts.get(token.token) ?? 0;
    if (token.lock.required && n !== 1) {
      return {
        ok: false,
        message: n === 0
          ? `missing required fact token ${token.token}`
          : `duplicated required fact token ${token.token}`,
      };
    }
    if (!token.lock.required && n > 1) {
      return { ok: false, message: `duplicated optional fact token ${token.token}` };
    }
    if (!token.lock.required && token.sourceOrder === null && n > 0) {
      return { ok: false, message: `inserted optional fact token ${token.token}` };
    }
  }
  let lastSourceOrder = -1;
  for (const found of foundTokens) {
    const sourceOrder = expected.get(found.token)!.sourceOrder;
    if (sourceOrder === null) continue;
    if (sourceOrder < lastSourceOrder) {
      return { ok: false, message: 'rewrite reordered fact tokens' };
    }
    lastSourceOrder = sourceOrder;
  }
  let comparisonText = rewritten;
  if (options) {
    const sourceTokens = listRewriteTokens(options.sourceText);
    if (
      sourceTokens.length !== foundTokens.length
      || sourceTokens.some((found, index) => found.token !== foundTokens[index]?.token)
    ) {
      return { ok: false, message: 'rewrite changed source fact-token presence or order' };
    }
    const allowedSkeletons = new Map([
      [rewriteLexicalSkeleton(options.sourceText), options.sourceText],
    ]);
    for (const phrase of options.removableLeadingPhrases ?? []) {
      const remaining = removeSafeLeadingPhrase(options.sourceText, phrase);
      if (remaining !== null) allowedSkeletons.set(rewriteLexicalSkeleton(remaining), remaining);
    }
    const acceptedSource = allowedSkeletons.get(rewriteLexicalSkeleton(rewritten));
    if (acceptedSource === undefined) {
      return {
        ok: false,
        message: 'rewrite changed words outside an approved non-semantic opener',
      };
    }
    comparisonText = acceptedSource;
    if (sourceTokens.length > 0) {
      const sourcePrefix = options.sourceText.slice(0, sourceTokens[0].start);
      const rewrittenPrefix = rewritten.slice(0, foundTokens[0].start);
      const allowedPrefixes = allowedLeadingConnectors(
        sourcePrefix,
        options.removableLeadingPhrases ?? [],
      );
      if (!allowedPrefixes.has(canonicalConnector(rewrittenPrefix))) {
        return { ok: false, message: 'rewrite changed text leading into a fact token' };
      }
      for (let i = 0; i < sourceTokens.length - 1; i += 1) {
        const sourceConnector = options.sourceText.slice(
          sourceTokens[i].end,
          sourceTokens[i + 1].start,
        );
        const rewrittenConnector = rewritten.slice(
          foundTokens[i].end,
          foundTokens[i + 1].start,
        );
        if (canonicalConnector(sourceConnector) !== canonicalConnector(rewrittenConnector)) {
          return { ok: false, message: 'rewrite changed text between fact tokens' };
        }
      }
      const sourceSuffix = options.sourceText.slice(sourceTokens.at(-1)!.end);
      const rewrittenSuffix = rewritten.slice(foundTokens.at(-1)!.end);
      if (canonicalConnector(sourceSuffix) !== canonicalConnector(rewrittenSuffix)) {
        return { ok: false, message: 'rewrite changed text following a fact token' };
      }
    }
  }
  return { ok: true, comparisonText };
}

export function validatePreservedFactTokens(
  before: string,
  after: string,
  tokens: readonly FactToken[],
): { ok: true } | FactLockFailure {
  const known = new Set(tokens.map((token) => token.token));
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const found of listRewriteTokens(before)) {
    beforeCounts.set(found.token, (beforeCounts.get(found.token) ?? 0) + 1);
  }
  for (const found of listRewriteTokens(after)) {
    if (!known.has(found.token)) {
      return { ok: false, message: `speech normalization introduced fact token ${found.token}` };
    }
    afterCounts.set(found.token, (afterCounts.get(found.token) ?? 0) + 1);
  }
  for (const token of tokens) {
    if ((beforeCounts.get(token.token) ?? 0) !== (afterCounts.get(token.token) ?? 0)) {
      return { ok: false, message: `speech normalization changed fact token ${token.token}` };
    }
  }
  const beforeOrder = listRewriteTokens(before).map((found) => found.token);
  const afterOrder = listRewriteTokens(after).map((found) => found.token);
  if (beforeOrder.some((token, index) => token !== afterOrder[index])) {
    return { ok: false, message: 'speech normalization reordered fact tokens' };
  }
  return { ok: true };
}

function restoreFactLockValues(
  text: string,
  tokens: readonly FactToken[],
  valueFor: (lock: FactLock) => string,
): { ok: true; text: string } | FactLockFailure {
  const check = validateRewriteTokens(text, tokens);
  if (!check.ok) return check;
  let next = text;
  for (const token of tokens) {
    next = next.split(token.token).join(valueFor(token.lock));
  }
  if (listRewriteTokens(next).length > 0) {
    return { ok: false, message: 'unresolved fact token after restore' };
  }
  return { ok: true, text: next };
}

export function restoreFactLocks(
  text: string,
  tokens: readonly FactToken[],
): { ok: true; text: string } | FactLockFailure {
  return restoreFactLockValues(text, tokens, (lock) => lock.displayValue);
}

export function restoreSpokenFactLocks(
  text: string,
  tokens: readonly FactToken[],
): { ok: true; text: string } | FactLockFailure {
  return restoreFactLockValues(text, tokens, spokenLockExpected);
}

export function validateRestoredCardinality(
  text: string,
  locks: readonly FactLock[],
): { ok: true } | FactLockFailure {
  const allocation = allocateFactLockSpans(text, locks);
  return allocation.ok ? { ok: true } : allocation;
}

export function maskLockedSpans(text: string, locks: readonly FactLock[]): string {
  const allocation = allocateFactLockSpans(text, locks);
  if (!allocation.ok) return text;
  let next = text;
  for (const span of [...allocation.spans].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, span.start) + ' '.repeat(span.end - span.start) + next.slice(span.end);
  }
  return next.replace(/\s+/g, ' ').trim();
}

const NUMBER_RE = /(?:\p{N}+(?:[,.]\p{N}+)*|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b)/giu;
const MONTHS = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/giu;
const WEEKDAYS = /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/giu;
const DATE_MAY_CONTEXT = new Set([
  'after', 'before', 'by', 'during', 'early', 'from', 'in', 'late', 'next',
  'on', 'since', 'through', 'until',
]);
const URL_RE = /(?:https?:\/\/[^\s]+|\bwww\.[^\s]+|\b(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:[\p{L}]{2,63}|xn--[\p{L}\p{N}-]{2,59})\b(?:\/[^\s]*)?)/giu;
const MEASURE_RE = /(?:°\s*[CF]\b|\b(?:km\/h|kilomet(?:er|re)s?(?:\s+per\s+hour)?|km|centimet(?:er|re)s?|cm|millimet(?:er|re)s?|mm|met(?:er|re)s?|hectares?|degrees?\s+celsius|celsius|per\s+cent|percent)\b)/giu;
const TIME_RE = /\b(?:\d{1,2}:\d{2}(?:\s*(?:a\.?m\.?|p\.?m\.?))?|\d{1,2}\s*(?:a\.?m\.?|p\.?m\.?)|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:a\.?m\.?|p\.?m\.?|o['’]?clock)|(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty)\s+(?:past|to)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)|quarter\s+(?:past|to)\s+\w+|half\s+past\s+\w+|noon|midnight)\b/giu;
const SPOKEN_CLOCK_RE = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:oh\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|forty(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|fifty(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?)\b/giu;
const NUMERIC_DATE_RE = /\b(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})\b/gu;
const CALENDAR_DATE_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[\s-](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[\s-]one)?)\b/giu;
const RELATIVE_DATE_RE = /\b(?:(?:today|tomorrow|yesterday)|(?:this|next|last)\s+(?:week|weekend|month|year|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|January|February|March|April|May|June|July|August|September|October|November|December))\b/giu;
const RELATIVE_TIME_RE = /\b(?:right\s+now|now|tonight|(?:this|next|last)\s+(?:morning|afternoon|evening|night)|(?:in|within)\s+(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:minutes?|hours?|days?))\b/giu;
const DIRECTION_RE = /\b(?:north|south|east|west|north[\s-]?east|north[\s-]?west|south[\s-]?east|south[\s-]?west|northerly|southerly|easterly|westerly)\b/giu;
const ATTRIBUTION_RE = /\b(?:according to|reported by|reports?|says|said|states?|announced by)\b/giu;
const DEFAULT_CUE_WORDS = ['release', 'chart', 'album', 'wrote', 'recorded'];

export type NewFactKind =
  | 'number'
  | 'measurement'
  | 'date'
  | 'time'
  | 'direction'
  | 'url'
  | 'attribution'
  | 'cue'
  | 'proper-name';

export type NewFactHit = { kind: NewFactKind; text: string };

function wordBoundaryCue(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'giu');
}

function factualMatches(kind: NewFactKind, text: string, re: RegExp): NewFactHit[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((match) => ({ kind, text: match[0] }));
}

function monthMatches(text: string): NewFactHit[] {
  MONTHS.lastIndex = 0;
  const hits: NewFactHit[] = [];
  for (const match of text.matchAll(MONTHS)) {
    const value = match[0];
    if (value === 'may') {
      const before = text
        .slice(0, match.index)
        .match(/(\p{L}+)\P{L}*$/u)?.[1]
        ?.toLocaleLowerCase('und');
      if (!before || !DATE_MAY_CONTEXT.has(before)) continue;
    }
    if (
      value === 'May'
      && match.index === 0
      && /^\s+(?:I|we|you|he|she|they|it)\b/u.test(text.slice(value.length))
    ) {
      continue;
    }
    hits.push({ kind: 'date', text: value });
  }
  return hits;
}

export function findNewFactualClaims(
  masked: string,
  cueWords: readonly string[] = DEFAULT_CUE_WORDS,
): NewFactHit[] {
  const hits: NewFactHit[] = [
    ...factualMatches('number', masked, NUMBER_RE),
    ...factualMatches('measurement', masked, MEASURE_RE),
    ...factualMatches('date', masked, NUMERIC_DATE_RE),
    ...factualMatches('date', masked, CALENDAR_DATE_RE),
    ...monthMatches(masked),
    ...factualMatches('date', masked, WEEKDAYS),
    ...factualMatches('date', masked, RELATIVE_DATE_RE),
    ...factualMatches('time', masked, TIME_RE),
    ...factualMatches('time', masked, SPOKEN_CLOCK_RE),
    ...factualMatches('time', masked, RELATIVE_TIME_RE),
    ...factualMatches('direction', masked, DIRECTION_RE),
    ...factualMatches('url', masked, URL_RE),
    ...factualMatches('attribution', masked, ATTRIBUTION_RE),
  ];
  for (const cue of cueWords) {
    hits.push(...factualMatches('cue', masked, wordBoundaryCue(cue)));
  }
  return hits;
}

const SENTENCE_OPENER_ALLOW = new Set([
  'a', 'affecting', 'an', 'and', 'back', 'beside', 'but', 'clear', 'coming',
  'covering', 'currently', 'details', 'fine', 'for', 'forecast', 'from', 'good',
  'here', 'i', "i'm", "i've", 'in',
  'it', "it's", 'its', 'listen', 'more', 'next', 'on', 'plain', 'rain', 'right',
  'roads', 'snow', 'still', 'that', 'the', 'there', 'this', 'to', 'today',
  'tomorrow', 'tonight', 'up', 'warm', 'we', 'weather', 'wind', 'with', 'you',
]);

export function findCapitalizedProperNames(
  masked: string,
  includeSentenceInitial = false,
): NewFactHit[] {
  const hits: NewFactHit[] = [];
  const sentences = masked.split(/(?<=[.!?…])\s+/);
  for (const sentence of sentences) {
    const words = sentence.match(/\p{L}[\p{L}\p{M}'’\-]*/gu) ?? [];
    words.forEach((word, i) => {
      if (i === 0) {
        // Ordinary copy has to capitalize its first word. Strict constrained
        // forms (track links) may opt into treating unknown openers as names;
        // rewrite comparison below handles new lower/upper-case lexemes
        // without misclassifying unchanged weather prose.
        if (
          includeSentenceInitial
          && !SENTENCE_OPENER_ALLOW.has(word.toLocaleLowerCase('und'))
        ) {
          hits.push({ kind: 'proper-name', text: word });
        }
        return;
      }
      if (/^\p{Lu}/u.test(word)) hits.push({ kind: 'proper-name', text: word });
    });
  }
  return hits;
}

function factualKey(hit: NewFactHit): string {
  return `${hit.kind}:${unicodeCaseFold(hit.text.normalize('NFKC')).replace(/\s+/gu, ' ').trim()}`;
}

const REWRITE_LEXEME_ALLOW = new Set([
  'a', 'am', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being', 'but', 'by',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'if', 'in', 'into',
  'is', 'it', 'its', 'of', 'on', 'or', 'than', 'that', 'the', 'then', 'there',
  'these', 'this', 'those', 'to', 'was', 'we', 'were', 'with', 'you', 'your',
]);

function lexicalWords(text: string): string[] {
  return (text.match(/\p{L}[\p{L}\p{M}'’\-]*/gu) ?? [])
    .map((word) => unicodeCaseFold(word.normalize('NFKC')).replaceAll('’', "'"));
}

// Source-backed copy may add only connective/template language around locked
// source values. Conditions, outcomes, dates, names and other assertion words
// belong in source-bound locks; otherwise a caller could ground one harmless
// value and invent the rest of the sentence.
const SOURCE_COPY_GRAMMAR_ALLOW = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'beside',
  'between', 'but', 'by', 'for', 'from', 'in', 'inside', 'into', 'is', 'it',
  'its', 'near', 'of', 'on', 'or', 'our', 'outside', 'over', 'that', 'the',
  'their', 'there', 'these', 'this', 'those', 'through', 'to', 'toward',
  'towards', 'under', 'update', 'upon', 'was', 'we', 'were', 'with', 'within',
  'you', 'your',
]);

export function findUnlockedSourceWords(
  maskedText: string,
  verifiedTemplateWords: readonly string[] = [],
): string[] {
  const allowed = new Set([
    ...SOURCE_COPY_GRAMMAR_ALLOW,
    ...verifiedTemplateWords.map((word) => unicodeCaseFold(word.normalize('NFKC'))),
  ]);
  return [...new Set(
    lexicalWords(maskedText).filter((word) => !allowed.has(word)),
  )];
}

const FACTUAL_ADJACENCY_WORDS = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
  'million', 'billion', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
  'seventh', 'eighth', 'ninth', 'tenth', 'next', 'last', 'this', 'today',
  'tomorrow', 'yesterday', 'tonight', 'morning', 'afternoon', 'evening',
  'night', 'now', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'week',
  'weeks', 'weekend', 'month', 'months', 'year', 'years', 'january', 'february', 'march',
  'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november',
  'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday',
  'saturday', 'sunday', 'am', 'pm', "o'clock", 'noon', 'midnight', 'past',
  'quarter', 'half', 'kilometre', 'kilometres', 'kilometer', 'kilometers', 'km',
  'centimetre', 'centimetres', 'centimeter', 'centimeters', 'cm', 'millimetre',
  'millimetres', 'millimeter', 'millimeters', 'mm', 'metre', 'metres', 'meter',
  'meters', 'hectare', 'hectares', 'degree', 'degrees', 'celsius', 'percent',
  'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast',
  'southwest', 'northerly', 'southerly', 'easterly', 'westerly', 'release',
  'chart', 'album', 'wrote', 'recorded', 'according', 'report', 'reports',
  'reported', 'says', 'said', 'state', 'states', 'announced',
]);

type StructuralGram = { key: string; text: string };

function factualStructuralGrams(text: string): StructuralGram[] {
  const tokens = (
    text.match(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*|[^\s\p{L}\p{M}\p{N}]/gu)
    ?? []
  ).map((token) => unicodeCaseFold(token.normalize('NFKC')).replaceAll('’', "'"));
  const grams: StructuralGram[] = [];
  for (const size of [2, 3]) {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const window = tokens.slice(i, i + size);
      const anchored = window.some((token) => (
        /\p{N}/u.test(token) || FACTUAL_ADJACENCY_WORDS.has(token)
      ));
      if (anchored) grams.push({ key: window.join('\u0000'), text: window.join(' ') });
    }
  }
  return grams;
}

function addedFactualStructuralGrams(before: string, after: string): NewFactHit[] {
  const counts = new Map<string, number>();
  for (const gram of factualStructuralGrams(before)) {
    counts.set(gram.key, (counts.get(gram.key) ?? 0) + 1);
  }
  const added: NewFactHit[] = [];
  for (const gram of factualStructuralGrams(after)) {
    const remaining = counts.get(gram.key) ?? 0;
    if (remaining > 0) counts.set(gram.key, remaining - 1);
    else added.push({ kind: 'time', text: gram.text });
  }
  return added;
}

export function addedFactualClaims(before: string, after: string): NewFactHit[] {
  const beforeHits = [...findNewFactualClaims(before), ...findCapitalizedProperNames(before)];
  const afterHits = [...findNewFactualClaims(after), ...findCapitalizedProperNames(after)];
  const counts = new Map<string, number>();
  for (const hit of beforeHits) {
    const key = factualKey(hit);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const added: NewFactHit[] = [];
  for (const hit of afterHits) {
    const key = factualKey(hit);
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) counts.set(key, remaining - 1);
    else added.push(hit);
  }
  added.push(...addedFactualStructuralGrams(before, after));
  const beforeWords = new Map<string, number>();
  for (const word of lexicalWords(before)) {
    beforeWords.set(word, (beforeWords.get(word) ?? 0) + 1);
  }
  for (const word of lexicalWords(after)) {
    const remaining = beforeWords.get(word) ?? 0;
    if (remaining > 0) {
      beforeWords.set(word, remaining - 1);
    } else if (!REWRITE_LEXEME_ALLOW.has(word)) {
      added.push({ kind: 'proper-name', text: word });
    }
  }
  return added;
}

export function spokenLockExpected(lock: FactLock): string {
  return lock.spokenValue ?? lock.displayValue;
}

export function validateSpokenLocks(
  spokenText: string,
  locks: readonly FactLock[],
): { ok: true } | FactLockFailure {
  const allocation = allocateFactLockSpans(spokenText, locks, true);
  if (!allocation.ok) {
    const failedId = locks.find((lock) => allocation.message.includes(lock.id))?.id;
    const lock = locks.find((row) => row.id === failedId);
    return {
      ok: false,
      message: lock?.spokenValue
        ? `spoken fact ${lock.id} must equal its approved spoken value`
        : `speech correction changed fact ${lock?.id ?? 'lock'} without an approved spoken value`,
    };
  }
  return { ok: true };
}
