// Runtime schemas and inferred types for rendered-voice measurement evidence
// and the durable audit ledger. Persistence lives in the sibling modules; this
// file remains the one contract surface imported by the renderer and Queue.

import { z } from 'zod';
import {
  provenanceLeaseSchema,
  reviewedAssetWaiverSchema,
  voiceArtifactSchema,
  voiceDurationProfileSchema,
  voiceQaStageSchema,
  voiceRejectCodeSchema,
  voiceRenderSnapshotSchema,
} from '../../schemas/voice.js';
import { canonicalSha256 } from '../../util/canonical-json.js';

const auditTextSchema = z.string().max(50_000);
const auditIdSchema = z.string().min(1).max(256);
const auditHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const auditRuleIdSchema = z.string().min(1).max(128);

interface VoiceMeasurementShape {
  durationMs: number;
  firstVoiceMs: number;
  lastVoiceMs: number;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  internalPausesMs: number[];
}

function voiceMeasurementIssues(
  value: VoiceMeasurementShape,
): Array<{ path: Array<string | number>; message: string }> {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (value.firstVoiceMs > value.lastVoiceMs) {
    issues.push({ path: ['firstVoiceMs'], message: 'first voice occurs after last voice' });
  }
  if (value.firstVoiceMs > value.durationMs || value.lastVoiceMs > value.durationMs) {
    issues.push({ path: ['lastVoiceMs'], message: 'voice bounds exceed audio duration' });
  }
  if (
    value.leadingSilenceMs > value.durationMs
    || value.trailingSilenceMs > value.durationMs
    || value.leadingSilenceMs + value.trailingSilenceMs > value.durationMs
  ) {
    issues.push({ path: ['leadingSilenceMs'], message: 'edge silence exceeds audio duration' });
  }
  if (
    value.firstVoiceMs < value.leadingSilenceMs
    || value.lastVoiceMs > value.durationMs - value.trailingSilenceMs
  ) {
    issues.push({ path: ['firstVoiceMs'], message: 'voice bounds contradict edge silence' });
  }
  for (let index = 0; index < value.internalPausesMs.length; index++) {
    if (value.internalPausesMs[index] > value.durationMs) {
      issues.push({
        path: ['internalPausesMs', index],
        message: 'internal pause exceeds audio duration',
      });
    }
  }
  return issues;
}

export const voiceSilenceIntervalSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
}).strict().superRefine((interval, ctx) => {
  if (interval.endMs < interval.startMs) {
    ctx.addIssue({ code: 'custom', message: 'silence interval ends before it starts' });
  }
});

export const voiceAudioSnapshotSchema = z.object({
  stage: z.enum(['decoded', 'temporal-edits', 'normalized', 'final']),
  codecName: z.string().min(1).max(128),
  sampleRateHz: z.number().int().positive().max(768_000),
  channels: z.number().int().positive().max(64),
  durationMs: z.number().int().nonnegative(),
  loudnessLufs: z.number().nullable(),
  truePeakDbtp: z.number().nullable(),
  leadingSilenceMs: z.number().int().nonnegative(),
  trailingSilenceMs: z.number().int().nonnegative(),
  silenceIntervals: z.array(voiceSilenceIntervalSchema).max(10_000),
}).strict().superRefine((snapshot, ctx) => {
  if (
    snapshot.leadingSilenceMs > snapshot.durationMs
    || snapshot.trailingSilenceMs > snapshot.durationMs
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['leadingSilenceMs'],
      message: 'edge silence exceeds snapshot duration',
    });
  }
  let previousEnd = -1;
  for (let i = 0; i < snapshot.silenceIntervals.length; i++) {
    const interval = snapshot.silenceIntervals[i];
    if (interval.endMs > snapshot.durationMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['silenceIntervals', i, 'endMs'],
        message: 'silence interval exceeds snapshot duration',
      });
    }
    if (interval.startMs < previousEnd) {
      ctx.addIssue({
        code: 'custom',
        path: ['silenceIntervals', i],
        message: 'silence intervals overlap or are out of order',
      });
    }
    previousEnd = interval.endMs;
  }
});
export type VoiceAudioSnapshot = z.infer<typeof voiceAudioSnapshotSchema>;

export const voicePauseEditSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  beforeMs: z.number().int().nonnegative(),
  afterMs: z.number().int().nonnegative(),
}).strict().superRefine((edit, ctx) => {
  if (edit.endMs < edit.startMs) {
    ctx.addIssue({ code: 'custom', message: 'pause edit ends before it starts' });
  }
});

export const voiceAudioEditRecordSchema = z.object({
  leadingTrimMs: z.number().int().nonnegative(),
  trailingTrimMs: z.number().int().nonnegative(),
  pauseEdits: z.array(voicePauseEditSchema).max(10_000),
  edgeFadeMs: z.literal(40),
  loudnormPasses: z.literal(2),
  waiver: reviewedAssetWaiverSchema.strict().optional(),
}).strict();
export type VoiceAudioEditRecord = z.infer<typeof voiceAudioEditRecordSchema>;

export const voiceAudioEvidenceSchema = z.object({
  decoded: voiceAudioSnapshotSchema,
  temporalEdits: voiceAudioSnapshotSchema,
  normalized: voiceAudioSnapshotSchema,
  final: voiceAudioSnapshotSchema,
}).strict().superRefine((evidence, ctx) => {
  const expected: Array<[keyof typeof evidence, VoiceAudioSnapshot['stage']]> = [
    ['decoded', 'decoded'],
    ['temporalEdits', 'temporal-edits'],
    ['normalized', 'normalized'],
    ['final', 'final'],
  ];
  for (const [key, stage] of expected) {
    if (evidence[key].stage !== stage) {
      ctx.addIssue({
        code: 'custom',
        path: [key, 'stage'],
        message: `${key} snapshot must carry stage ${stage}`,
      });
    }
  }
});
export type VoiceAudioEvidence = z.infer<typeof voiceAudioEvidenceSchema>;

export const renderAttemptBaseSchema = z.object({
  targetKey: z.string().min(1).max(256),
  engine: z.string().min(1).max(128),
  provider: z.string().min(1).max(128).optional(),
  voice: z.string().min(1).max(512).optional(),
  textHash: auditHashSchema,
  targetConfigHash: auditHashSchema,
  startedAtMs: z.number().int().nonnegative(),
  endedAtMs: z.number().int().nonnegative(),
}).strict();
export type RenderAttemptBase = z.infer<typeof renderAttemptBaseSchema>;

const acceptedRenderAttemptSchema = renderAttemptBaseSchema.extend({
  status: z.literal('accepted'),
  evidence: voiceAudioEvidenceSchema,
  edits: voiceAudioEditRecordSchema,
});

const partialVoiceAudioEvidenceSchema = z.object({
  decoded: voiceAudioSnapshotSchema.optional(),
  temporalEdits: voiceAudioSnapshotSchema.optional(),
  normalized: voiceAudioSnapshotSchema.optional(),
  final: voiceAudioSnapshotSchema.optional(),
}).strict().superRefine((evidence, ctx) => {
  const expected: Array<[keyof typeof evidence, VoiceAudioSnapshot['stage']]> = [
    ['decoded', 'decoded'],
    ['temporalEdits', 'temporal-edits'],
    ['normalized', 'normalized'],
    ['final', 'final'],
  ];
  for (const [key, stage] of expected) {
    const snapshot = evidence[key];
    if (snapshot && snapshot.stage !== stage) {
      ctx.addIssue({
        code: 'custom',
        path: [key, 'stage'],
        message: `${key} snapshot must carry stage ${stage}`,
      });
    }
  }
});

const failedRenderAttemptSchema = renderAttemptBaseSchema.extend({
  status: z.literal('failed'),
  failedStage: voiceQaStageSchema,
  failureCode: voiceRejectCodeSchema,
  evidence: partialVoiceAudioEvidenceSchema,
  edits: voiceAudioEditRecordSchema.optional(),
});

export const renderAttemptRecordSchema = z.discriminatedUnion('status', [
  acceptedRenderAttemptSchema,
  failedRenderAttemptSchema,
]).superRefine((attempt, ctx) => {
  if (attempt.endedAtMs < attempt.startedAtMs) {
    ctx.addIssue({
      code: 'custom',
      path: ['endedAtMs'],
      message: 'render attempt ends before it starts',
    });
  }
  if (attempt.status === 'failed') {
    const keys = ['decoded', 'temporalEdits', 'normalized', 'final'] as const;
    const lastPresent = keys.reduce(
      (last, key, index) => attempt.evidence[key] ? index : last,
      -1,
    );
    for (let index = 0; index <= lastPresent; index++) {
      if (!attempt.evidence[keys[index]]) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence', keys[index]],
          message: 'failed render evidence must be a contiguous stage prefix',
        });
      }
    }
    const maxEvidenceByFailureStage: Record<
      z.infer<typeof voiceQaStageSchema>,
      number
    > = {
      'text-policy': 0,
      rewrite: 0,
      render: 0,
      probe: 0,
      decode: 1,
      silence: 2,
      loudness: 3,
      'final-inspection': 4,
      publish: 4,
      audit: 4,
    };
    if (lastPresent + 1 > maxEvidenceByFailureStage[attempt.failedStage]) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: `failed render evidence exceeds stage ${attempt.failedStage}`,
      });
    }
  }
});
export type RenderAttemptRecord = z.infer<typeof renderAttemptRecordSchema>;

export const VOICE_AUDIT_TYPE_VALUES = [
  'voice.text_policy',
  'voice.rewrite',
  'voice.render_attempt',
  'voice.qa_passed',
  'voice.qa_failed',
  'voice.artifact',
  'voice.policy_reserved',
  'voice.policy_released',
  'voice.queued',
  'voice.started',
  'voice.ended',
  'voice.dropped',
] as const;
export const voiceAuditTypeSchema = z.enum(VOICE_AUDIT_TYPE_VALUES);
export type VoiceAuditType = z.infer<typeof voiceAuditTypeSchema>;

export const STATION_HOUR_KEY_RE =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])[+-]\d{4}@[A-Za-z0-9._+-]+(?:_[A-Za-z0-9._+-]+)*$/;
export const stationHourKeySchema = z.string().regex(STATION_HOUR_KEY_RE);

const voiceAuditEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: auditIdSchema,
  atMs: z.number().int().nonnegative(),
  auditId: auditIdSchema,
  traceId: auditIdSchema.optional(),
  candidateId: auditIdSchema.optional(),
  voiceId: auditIdSchema.optional(),
  stationHourKey: stationHourKeySchema,
}).strict();

const replacementAuditSchema = z.object({
  ruleId: auditRuleIdSchema,
  step: z.number().int().positive(),
  inputTextHash: auditHashSchema,
  sourceStart: z.number().int().nonnegative(),
  sourceEnd: z.number().int().nonnegative(),
  matchedText: auditTextSchema.min(1),
  matchedTextHash: auditHashSchema,
  replacement: auditTextSchema,
}).strict().superRefine((replacement, ctx) => {
  if (replacement.sourceEnd <= replacement.sourceStart) {
    ctx.addIssue({ code: 'custom', message: 'replacement source span must be non-empty' });
  }
});

const textPolicyPayloadSchema = z.object({
  outcome: z.enum(['passed', 'rejected']),
  inputDisplayText: auditTextSchema,
  inputDisplayTextHash: auditHashSchema,
  displayText: auditTextSchema,
  displayTextHash: auditHashSchema,
  spokenTextHash: auditHashSchema.optional(),
  passedRuleIds: z.array(auditRuleIdSchema).max(1_000),
  failedRuleIds: z.array(auditRuleIdSchema).max(1_000),
  replacements: z.array(replacementAuditSchema).max(1_000),
  factLocksHash: auditHashSchema,
  provenance: provenanceLeaseSchema.optional(),
  renderSnapshot: voiceRenderSnapshotSchema.strict(),
}).strict();

const rewritePayloadSchema = z.object({
  count: z.literal(1),
  beforeHash: auditHashSchema,
  afterHash: auditHashSchema,
  outcome: z.enum(['passed', 'rejected']),
  failedRuleIds: z.array(auditRuleIdSchema).max(1_000),
}).strict().superRefine((rewrite, ctx) => {
  if (rewrite.outcome === 'passed' && rewrite.beforeHash === rewrite.afterHash) {
    ctx.addIssue({
      code: 'custom',
      path: ['afterHash'],
      message: 'a passed rewrite must change the text hash',
    });
  }
});

const artifactMeasurementsSchema = voiceArtifactSchema.pick({
  durationMs: true,
  firstVoiceMs: true,
  lastVoiceMs: true,
  loudnessLufs: true,
  truePeakDbtp: true,
  leadingSilenceMs: true,
  trailingSilenceMs: true,
  internalPausesMs: true,
}).strict().superRefine((measurements, ctx) => {
  for (const issue of voiceMeasurementIssues(measurements)) {
    ctx.addIssue({ code: 'custom', ...issue });
  }
});

const qaPassedPayloadSchema = z.object({
  artifactId: auditIdSchema,
  profile: voiceDurationProfileSchema,
  measurements: artifactMeasurementsSchema,
}).strict();

const qaFailedPayloadSchema = z.object({
  stage: voiceQaStageSchema,
  code: voiceRejectCodeSchema,
  attempt: renderAttemptRecordSchema.optional(),
}).strict();

const artifactPayloadSchema = z.object({
  artifact: voiceArtifactSchema.strict(),
  provenance: provenanceLeaseSchema.optional(),
}).strict().superRefine((payload, ctx) => {
  for (const issue of voiceMeasurementIssues(payload.artifact)) {
    ctx.addIssue({ code: 'custom', path: ['artifact', ...issue.path], message: issue.message });
  }
});

const policyReservedPayloadSchema = z.object({
  reservationId: auditIdSchema,
  ruleId: auditRuleIdSchema,
  value: auditTextSchema,
  stationHourKey: stationHourKeySchema,
  expiresAtMs: z.number().int().nonnegative(),
}).strict();

const policyReleasedPayloadSchema = z.object({
  reservationId: auditIdSchema,
  reason: z.enum(['started', 'dropped', 'expired', 'recovered']),
}).strict();

const queuedPayloadSchema = z.object({
  artifactId: auditIdSchema,
  queue: z.enum(['say', 'intro', 'exchange']),
  queuedAtMs: z.number().int().nonnegative(),
}).strict();

const startedPayloadSchema = z.object({
  artifactId: auditIdSchema,
  queue: z.enum(['say', 'intro', 'exchange']),
  clipStartedAt: z.number().int().nonnegative(),
  audibleStartedAt: z.number().int().nonnegative(),
  measured: z.boolean(),
}).strict();

const endedPayloadSchema = z.object({
  artifactId: auditIdSchema,
  clipEndedAt: z.number().int().nonnegative(),
  audibleEndedAt: z.number().int().nonnegative().optional(),
  measured: z.boolean(),
  reason: z.enum(['natural', 'timer', 'interrupted', 'unknown']),
}).strict();

const droppedPayloadSchema = z.object({
  code: z.union([
    voiceRejectCodeSchema,
    z.enum(['cancelled', 'stale', 'handoff_failed']),
  ]),
  stage: z.union([voiceQaStageSchema, z.enum(['queue', 'airtime'])]),
}).strict();

const voiceAuditEventUnionSchema = z.discriminatedUnion('type', [
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.text_policy'),
    payload: textPolicyPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.rewrite'),
    payload: rewritePayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.render_attempt'),
    payload: renderAttemptRecordSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.qa_passed'),
    payload: qaPassedPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.qa_failed'),
    payload: qaFailedPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.artifact'),
    payload: artifactPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.policy_reserved'),
    payload: policyReservedPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.policy_released'),
    payload: policyReleasedPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.queued'),
    payload: queuedPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.started'),
    payload: startedPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.ended'),
    payload: endedPayloadSchema,
  }),
  voiceAuditEnvelopeSchema.extend({
    type: z.literal('voice.dropped'),
    payload: droppedPayloadSchema,
  }),
]);

const ABSOLUTE_HOST_PATH =
  /(?:^|[\s"'(=])(?:file:\/\/|[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^\s\\/]+[\\/][^\s\\/]+|\/(?!\/)[^\s/\\]+(?:\/[^\s/\\]+)*)/iu;
const EMBEDDED_HTTP_URL = /https?:\/\/[^\s<>"']+/gi;
const EMBEDDED_CREDENTIAL =
  /\b(?:authorization|x-api-key|api[-_ ]?key)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i;
const EMBEDDED_ASSIGNMENT =
  /\b([A-Za-z][A-Za-z0-9_.-]{0,63})\s*[:=]\s*(?:"[^"]+"|'[^']+'|[^\s,;]+)/g;
const EMBEDDED_QUOTED_KEY =
  /["']([A-Za-z][A-Za-z0-9_. -]{0,63})["']\s*[:=]/g;
const EMBEDDED_SEMANTIC_CREDENTIAL =
  /["'](?:key|name)["']\s*:\s*["']([^"']{1,128})["']/gi;
const EXACT_CREDENTIAL_QUERY_KEYS = new Set([
  'awsaccesskeyid',
  'key',
  'key-pair-id',
  'sv',
  'se',
  'sp',
  'sr',
  'skoid',
  'sktid',
  'skt',
  'ske',
  'sks',
  'skv',
]);
const CREDENTIAL_QUERY_FRAGMENT =
  /(?:^|[-_])(?:api[-_]?key|auth(?:orization)?|credentials?|password|secret|signature|sig|tokens?|access[-_]?token|subscription[-_]?key)(?:$|[-_])/i;
const NON_SECRET_KEY_NAMES = new Set([
  'entity_key',
  'revalidation_key',
  'station_hour_key',
  'target_key',
]);

function normalizedCredentialName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function isSensitiveCredentialName(key: string): boolean {
  const normalized = normalizedCredentialName(key);
  if (NON_SECRET_KEY_NAMES.has(normalized)) return false;
  const compact = normalized.replaceAll('_', '');
  return (
    (
      normalized !== 'key'
      && /(?:^|_)key(?:_?id)?$/.test(normalized)
    )
    || /(?:^|_)(?:authorization|credentials?|credential_value|password|secret|signed_url|tokens?|source_body|source_response|raw_response)$/
      .test(normalized)
    || /(?:(?:api|secret|access|private|signing|consumer|serviceaccount|subscription|encryption|account)key(?:id)?|(?:client|consumer|app)secret|(?:refresh|auth|access|bearer)token)$/
      .test(compact)
  );
}

export function isCredentialQueryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.startsWith('x-amz-')
    || normalized.startsWith('x-goog-')
    || EXACT_CREDENTIAL_QUERY_KEYS.has(normalized)
    || CREDENTIAL_QUERY_FRAGMENT.test(normalized)
    || isSensitiveCredentialName(key)
  );
}

export function auditStringPrivacyIssue(
  value: string,
  depth = 0,
): string | null {
  if (ABSOLUTE_HOST_PATH.test(value)) return 'absolute host path';
  if (EMBEDDED_CREDENTIAL.test(value)) return 'embedded credential';
  for (const match of value.matchAll(EMBEDDED_ASSIGNMENT)) {
    if (isSensitiveCredentialName(match[1]) || isCredentialQueryKey(match[1])) {
      return 'embedded credential';
    }
  }
  for (const match of value.matchAll(EMBEDDED_QUOTED_KEY)) {
    if (isSensitiveCredentialName(match[1]) || isCredentialQueryKey(match[1])) {
      return 'embedded credential';
    }
  }
  for (const match of value.matchAll(EMBEDDED_SEMANTIC_CREDENTIAL)) {
    if (isSensitiveCredentialName(match[1]) || isCredentialQueryKey(match[1])) {
      return 'embedded credential';
    }
  }
  for (const rawUrl of value.match(EMBEDDED_HTTP_URL) ?? []) {
    const candidate = rawUrl.replace(/[),.;!?]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.username || url.password) return 'URL credentials';
      if ([...url.searchParams.keys()].some(isCredentialQueryKey)) {
        return 'signed URL';
      }
    } catch {
      return 'malformed URL';
    }
  }
  if (depth < 16 && value.length <= 1_000_000) {
    const unescapedQuotes = value.replace(/\\+(?=["'])/g, '');
    if (unescapedQuotes !== value) {
      const issue = auditStringPrivacyIssue(unescapedQuotes, depth + 1);
      if (issue) return issue;
    }
  }
  const trimmed = value.trim();
  if (
    depth < 16
    && (
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    )
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const issue = privacyIssue(parsed, ['embeddedJson'], depth + 1);
      if (issue) return 'embedded unsafe JSON';
    } catch {
      // Ordinary strings that merely resemble JSON remain valid audit text.
    }
  } else if (depth >= 16 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return 'excessively nested JSON';
  }
  return null;
}

function privacyIssue(
  value: unknown,
  path: PropertyKey[] = [],
  depth = 0,
): string | null {
  if (depth > 32) return `excessive nesting at ${path.join('.')}`;
  if (typeof value === 'string') {
    const issue = auditStringPrivacyIssue(value, depth);
    if (issue) return `${issue} at ${path.join('.')}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const issue = privacyIssue(value[i], [...path, i], depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    const semanticKey = entries.find(([key]) => key === 'key' || key === 'name')?.[1];
    if (
      typeof semanticKey === 'string'
      && (isSensitiveCredentialName(semanticKey) || isCredentialQueryKey(semanticKey))
    ) {
      return `forbidden semantic key ${[...path, semanticKey].join('.')}`;
    }
    for (const [key, child] of entries) {
      if (isSensitiveCredentialName(key)) {
        return `forbidden field ${[...path, key].join('.')}`;
      }
      const issue = privacyIssue(child, [...path, key], depth + 1);
      if (issue) return issue;
    }
  }
  return null;
}

function hashIssue(value: unknown, path: PropertyKey[] = []): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const issue = hashIssue(value[i], [...path, i]);
      if (issue) return issue;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (
      (key.endsWith('Hash') || key === 'sha256' || key === 'payloadHash')
      && child !== undefined
      && (typeof child !== 'string' || !/^[a-f0-9]{64}$/.test(child))
    ) {
      return `invalid SHA-256 at ${[...path, key].join('.')}`;
    }
    const issue = hashIssue(child, [...path, key]);
    if (issue) return issue;
  }
  return null;
}

export const voiceAuditEventSchema = voiceAuditEventUnionSchema.superRefine((event, ctx) => {
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, 'utf8') > 1_000_000) {
    ctx.addIssue({ code: 'custom', message: 'voice audit event exceeds one megabyte' });
  }
  const issue = privacyIssue(event);
  if (issue) ctx.addIssue({ code: 'custom', message: `unsafe voice audit event: ${issue}` });
  const invalidHash = hashIssue(event);
  if (invalidHash) ctx.addIssue({ code: 'custom', message: invalidHash });
  if (
    event.type === 'voice.artifact'
    && event.payload.artifact.auditId !== event.auditId
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['payload', 'artifact', 'auditId'],
      message: 'artifact auditId does not match its audit envelope',
    });
  }
  if (event.type === 'voice.artifact') {
    const { artifact, provenance } = event.payload;
    if (provenance) {
      if (artifact.provenanceHash !== canonicalSha256(provenance)) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'artifact', 'provenanceHash'],
          message: 'artifact provenance hash does not match its lease',
        });
      }
      if (artifact.sourceExpiresAt !== provenance.expiresAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'artifact', 'sourceExpiresAt'],
          message: 'artifact source expiry does not match its lease',
        });
      }
    } else if (
      artifact.provenanceHash !== undefined
      || artifact.sourceExpiresAt !== undefined
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'artifact'],
        message: 'unsourced artifact cannot retain provenance fields',
      });
    }
  }
  if (
    event.type === 'voice.policy_reserved'
    && event.payload.stationHourKey !== event.stationHourKey
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['payload', 'stationHourKey'],
      message: 'reservation station-hour key does not match its audit envelope',
    });
  }
  if (
    (
      event.type === 'voice.queued'
      || event.type === 'voice.started'
      || event.type === 'voice.ended'
      || event.type === 'voice.policy_reserved'
      || event.type === 'voice.policy_released'
    )
    && event.voiceId === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['voiceId'],
      message: `${event.type} requires voiceId correlation`,
    });
  }
  if (
    event.type === 'voice.started'
    && event.payload.audibleStartedAt < event.payload.clipStartedAt
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['payload', 'audibleStartedAt'],
      message: 'audible voice cannot start before its clip',
    });
  }
  if (event.type === 'voice.ended') {
    if (event.payload.measured && event.payload.audibleEndedAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'audibleEndedAt'],
        message: 'a measured voice end requires audibleEndedAt',
      });
    }
    if (
      event.payload.audibleEndedAt !== undefined
      && event.payload.audibleEndedAt > event.payload.clipEndedAt
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'audibleEndedAt'],
        message: 'audible voice cannot end after its clip',
      });
    }
  }
  if (event.type === 'voice.qa_failed' && event.payload.attempt) {
    const { attempt } = event.payload;
    if (attempt.status !== 'failed') {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'attempt', 'status'],
        message: 'voice.qa_failed cannot contain an accepted attempt',
      });
    } else {
      if (attempt.failedStage !== event.payload.stage) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'stage'],
          message: 'voice.qa_failed stage does not match its attempt',
        });
      }
      if (attempt.failureCode !== event.payload.code) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'code'],
          message: 'voice.qa_failed code does not match its attempt',
        });
      }
    }
  }
  if (event.type === 'voice.text_policy') {
    const payload = event.payload;
    if (payload.outcome === 'passed' && payload.spokenTextHash === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'spokenTextHash'],
        message: 'passed text policy requires the final spoken-text hash',
      });
    }
    if (canonicalSha256(payload.inputDisplayText) !== payload.inputDisplayTextHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'inputDisplayTextHash'],
        message: 'input display text hash mismatch',
      });
    }
    if (canonicalSha256(payload.displayText) !== payload.displayTextHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['payload', 'displayTextHash'],
        message: 'display text hash mismatch',
      });
    }
    let stepText = payload.inputDisplayText;
    let previousStep = 0;
    for (let i = 0; i < payload.replacements.length;) {
      const step = payload.replacements[i].step;
      if (step <= previousStep) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', 'replacements', i, 'step'],
          message: 'replacement steps must be grouped in increasing order',
        });
      }
      const group: typeof payload.replacements = [];
      let j = i;
      while (j < payload.replacements.length && payload.replacements[j].step === step) {
        group.push(payload.replacements[j]);
        j += 1;
      }
      let previousEnd = -1;
      for (let k = 0; k < group.length; k++) {
        const replacement = group[k];
        const recordIndex = i + k;
        if (canonicalSha256(stepText) !== replacement.inputTextHash) {
          ctx.addIssue({
            code: 'custom',
            path: ['payload', 'replacements', recordIndex, 'inputTextHash'],
            message: 'replacement input hash mismatch',
          });
        }
        if (replacement.sourceStart < previousEnd) {
          ctx.addIssue({
            code: 'custom',
            path: ['payload', 'replacements', recordIndex],
            message: 'replacement spans overlap or are out of order',
          });
        }
        if (replacement.sourceEnd > stepText.length) {
          ctx.addIssue({
            code: 'custom',
            path: ['payload', 'replacements', recordIndex],
            message: 'replacement span exceeds UTF-16 input bounds',
          });
        }
        const matched = stepText.slice(replacement.sourceStart, replacement.sourceEnd);
        if (matched !== replacement.matchedText) {
          ctx.addIssue({
            code: 'custom',
            path: ['payload', 'replacements', recordIndex],
            message: 'replacement span does not match UTF-16 input indexes',
          });
        }
        if (canonicalSha256(replacement.matchedText) !== replacement.matchedTextHash) {
          ctx.addIssue({
            code: 'custom',
            path: ['payload', 'replacements', recordIndex, 'matchedTextHash'],
            message: 'replacement matched-text hash mismatch',
          });
        }
        previousEnd = replacement.sourceEnd;
      }
      for (const replacement of [...group].reverse()) {
        stepText =
          stepText.slice(0, replacement.sourceStart)
          + replacement.replacement
          + stepText.slice(replacement.sourceEnd);
      }
      previousStep = step;
      i = j;
    }
    // The deterministic replacement replay may be the input to one constrained
    // rewrite, so it is not required to equal the final display text. The
    // sibling voice.rewrite event carries that intermediate beforeHash and the
    // final displayTextHash without widening this Task 3 payload contract.
  }
});
export type VoiceAuditEvent = z.infer<typeof voiceAuditEventSchema>;

export const voiceAuditHealthSchema = z.object({
  schemaVersion: z.literal(1),
  auditUnhealthy: z.boolean(),
  sinceMs: z.number().int().nonnegative().nullable(),
  reason: z.string().min(1).max(2_000).nullable(),
  lastHealthyProbeAtMs: z.number().int().nonnegative().nullable(),
  lastRender: z.object({
    atMs: z.number().int().nonnegative(),
    trigger: z.enum(['real', 'operator']),
    status: z.enum(['accepted', 'failed']),
    targetKey: z.string().min(1).max(256).optional(),
  }).strict().nullable(),
}).strict().superRefine((health, ctx) => {
  if (health.auditUnhealthy && (health.sinceMs === null || health.reason === null)) {
    ctx.addIssue({ code: 'custom', message: 'an unhealthy audit latch needs sinceMs and reason' });
  }
  if (!health.auditUnhealthy && (health.sinceMs !== null || health.reason !== null)) {
    ctx.addIssue({ code: 'custom', message: 'a healthy audit latch cannot retain failure detail' });
  }
  const issue = privacyIssue(health);
  if (issue) {
    ctx.addIssue({ code: 'custom', message: `unsafe voice audit health: ${issue}` });
  }
});
export type VoiceAuditHealth = z.infer<typeof voiceAuditHealthSchema>;
