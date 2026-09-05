// Broadcast voice QA contracts — the serializable source of truth mirrored
// into web/lib/schemas.generated.ts. This file may import ONLY from 'zod'.
//
// Runtime request/result types that carry a Persona live in
// audio/voice-qa/contracts.ts. Measurement/audit evidence lives in
// broadcast/voice-audit/types.ts (later task).
import { z } from 'zod';

function deepFreezeBroadcastQaProfiles<
  T extends Record<string, Record<string, number>>,
>(profiles: T): Readonly<T> {
  for (const profile of Object.values(profiles)) Object.freeze(profile);
  return Object.freeze(profiles);
}

export const BROADCAST_QA_PROFILES = deepFreezeBroadcastQaProfiles({
  talkup: { minMs: 4000, maxMs: 12000, maxWords: 30, maxSentences: 2 },
  'bedded-link': { minMs: 0, maxMs: 15000, maxWords: 38, maxSentences: 2 },
  'scheduled-dropin': { minMs: 15000, maxMs: 30000, maxWords: 75, maxSentences: 4 },
  weather: { minMs: 10000, maxMs: 25000, maxWords: 63, maxSentences: 3 },
  roads: { minMs: 10000, maxMs: 25000, maxWords: 63, maxSentences: 3 },
  events: { minMs: 10000, maxMs: 25000, maxWords: 63, maxSentences: 3 },
  news: { minMs: 10000, maxMs: 25000, maxWords: 63, maxSentences: 3 },
  'ec-warning': { minMs: 0, maxMs: 25000, maxWords: 63, maxSentences: 3 },
  'top-of-hour': { minMs: 0, maxMs: 20000, maxWords: 50, maxSentences: 2 },
} as const);

export const VOICE_DURATION_PROFILE_VALUES = [
  'talkup',
  'bedded-link',
  'scheduled-dropin',
  'weather',
  'roads',
  'events',
  'news',
  'ec-warning',
  'top-of-hour',
] as const;

export const voiceDurationProfileSchema = z.enum(VOICE_DURATION_PROFILE_VALUES);
export type VoiceDurationProfile = z.infer<typeof voiceDurationProfileSchema>;

export const VOICE_FACT_LOCK_ID_RE = /^[a-z][a-z0-9_.-]{0,63}$/;

export const factLockSchema = z.object({
  id: z.string().regex(VOICE_FACT_LOCK_ID_RE),
  displayValue: z.string().min(1),
  required: z.boolean(),
  sourceRef: z.string().optional(),
  sourceRevision: z.string().optional(),
  spokenValue: z.string().optional(),
});
export type FactLock = z.infer<typeof factLockSchema>;

export const provenanceLeaseSchema = z.object({
  schemaVersion: z.literal(1),
  skillId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceRef: z.string().min(1),
  attribution: z.string().min(1),
  fetchedAt: z.string().min(1),
  expiresAt: z.string().min(1),
  entityKey: z.string().min(1),
  sourceRevision: z.string().min(1),
  payloadHash: z.string().min(1),
  candidateRevision: z.string().min(1),
  revalidationKey: z.string().min(1),
  groundedGeneration: z.number().int().optional(),
});
export type ProvenanceLease = z.infer<typeof provenanceLeaseSchema>;

export const reviewedAssetWaiverSchema = z.object({
  assetId: z.string().min(1),
  sha256: z.string().min(1),
  reviewer: z.string().min(1),
  reviewedAt: z.string().min(1),
  reviewedDurationMs: z.number().int().nonnegative(),
  allowLongPauses: z.literal(true),
});
export type ReviewedAssetWaiver = z.infer<typeof reviewedAssetWaiverSchema>;

export const ecWarningCopyProofSchema = z.object({
  schemaVersion: z.literal(1),
  alertReference: z.string().min(1),
  alertRevision: z.string().min(1),
  event: z.string().min(1),
  headline: z.string().min(1),
  verifiedPlaces: z.array(z.string().min(1)).min(1),
  timing: z.string().optional(),
  requiredUrlText: z.literal('weather.gc.ca'),
  fullDisplayText: z.string().min(1),
  mandatoryDisplayText: z.string().min(1),
  fullTextHash: z.string().min(1),
  mandatoryTextHash: z.string().min(1),
});
export type EcWarningCopyProof = z.infer<typeof ecWarningCopyProofSchema>;

export const VOICE_QA_STAGE_VALUES = [
  'text-policy',
  'rewrite',
  'render',
  'probe',
  'decode',
  'silence',
  'loudness',
  'final-inspection',
  'publish',
  'audit',
] as const;
export const voiceQaStageSchema = z.enum(VOICE_QA_STAGE_VALUES);
export type VoiceQaStage = z.infer<typeof voiceQaStageSchema>;

export const VOICE_REJECT_CODE_VALUES = [
  'text_policy_failed',
  'fact_lock_failed',
  'source_stale',
  'unsupported_profile',
  'no_render_target',
  'invalid_audio',
  'duration_out_of_range',
  'loudness_out_of_range',
  'true_peak_exceeded',
  'silence_out_of_range',
  'tool_unavailable',
  'audit_unavailable',
] as const;
export const voiceRejectCodeSchema = z.enum(VOICE_REJECT_CODE_VALUES);
export type VoiceRejectCode = z.infer<typeof voiceRejectCodeSchema>;

export const voiceRenderSnapshotSchema = z.object({
  capturedAtMs: z.number().int(),
  settingsHash: z.string().min(1),
  policyHash: z.string().min(1),
  profileHash: z.string().min(1),
  correctionsHash: z.string().min(1),
  ttsPlanHash: z.string().min(1),
  personaHash: z.string().optional(),
  legacyGainDb: z.number(),
});
export type VoiceRenderSnapshot = z.infer<typeof voiceRenderSnapshotSchema>;

export const VOICE_ARTIFACT_RELATIVE_PATH_RE = /^voice\/artifacts\/[A-Za-z0-9._-]+$/;

export const voiceArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  auditId: z.string().min(1),
  artifactId: z.string().min(1),
  path: z.string().regex(VOICE_ARTIFACT_RELATIVE_PATH_RE),
  sha256: z.string().min(1),
  displayText: z.string(),
  spokenText: z.string(),
  kind: z.string().min(1),
  profile: voiceDurationProfileSchema,
  durationMs: z.number().int().nonnegative(),
  firstVoiceMs: z.number().int().nonnegative(),
  lastVoiceMs: z.number().int().nonnegative(),
  loudnessLufs: z.number(),
  truePeakDbtp: z.number(),
  leadingSilenceMs: z.number().int().nonnegative(),
  trailingSilenceMs: z.number().int().nonnegative(),
  internalPausesMs: z.array(z.number().int().nonnegative()),
  engine: z.string().min(1),
  provider: z.string().optional(),
  voice: z.string().optional(),
  rewriteCount: z.union([z.literal(0), z.literal(1)]),
  factLocksHash: z.string().min(1),
  provenanceHash: z.string().optional(),
  sourceExpiresAt: z.string().optional(),
  renderSnapshot: voiceRenderSnapshotSchema,
  createdAt: z.string().min(1),
});
export type VoiceArtifact = z.infer<typeof voiceArtifactSchema>;

export const VOICE_LINK_ANNOUNCE_FORMS = ['this-is', 'next-up'] as const;
export const voiceLinkAnnounceFormSchema = z.enum(VOICE_LINK_ANNOUNCE_FORMS);

export type BroadcastQaReplacement = {
  id: string;
  match: string;
  replacement: string;
  caseSensitive: boolean;
  boundary: 'none' | 'start' | 'end' | 'both';
};

export type BroadcastQaRule =
  | { id: string; type: 'phrase'; value: string }
  | { id: string; type: 'first-line-opener'; value: string }
  | { id: string; type: 'sentence-opener'; value: string }
  | { id: string; type: 'station-hour-limit'; value: string; max: number };

export interface BroadcastQaSettings {
  enabled: boolean;
  replacements: BroadcastQaReplacement[];
  rules: BroadcastQaRule[];
  profiles: typeof BROADCAST_QA_PROFILES;
}
