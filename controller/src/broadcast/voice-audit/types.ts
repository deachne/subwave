// Contract-only audit evidence for rendered voice attempts.
//
// This module owns measurement and attempt records before the Task 3 ledger
// exists. It must stay free of runtime imports and persistence behaviour.

import type {
  ReviewedAssetWaiver,
  VoiceQaStage,
  VoiceRejectCode,
} from '../../schemas/voice.js';

export type RenderAttemptBase = {
  targetKey: string;
  engine: string;
  provider?: string;
  voice?: string;
  textHash: string;
  targetConfigHash: string;
  startedAtMs: number;
  endedAtMs: number;
};

export type VoiceAudioSnapshot = {
  stage: 'decoded' | 'temporal-edits' | 'normalized' | 'final';
  codecName: string;
  sampleRateHz: number;
  channels: number;
  durationMs: number;
  loudnessLufs: number | null;
  truePeakDbtp: number | null;
  leadingSilenceMs: number;
  trailingSilenceMs: number;
  silenceIntervals: Array<{ startMs: number; endMs: number }>;
};

export type VoiceAudioEditRecord = {
  leadingTrimMs: number;
  trailingTrimMs: number;
  pauseEdits: Array<{
    startMs: number;
    endMs: number;
    beforeMs: number;
    afterMs: number;
  }>;
  edgeFadeMs: 40;
  loudnormPasses: 2;
  waiver?: ReviewedAssetWaiver;
};

export type VoiceAudioEvidence = {
  decoded: VoiceAudioSnapshot;
  temporalEdits: VoiceAudioSnapshot;
  normalized: VoiceAudioSnapshot;
  final: VoiceAudioSnapshot;
};

export type RenderAttemptRecord =
  | (RenderAttemptBase & {
      status: 'accepted';
      evidence: VoiceAudioEvidence;
      edits: VoiceAudioEditRecord;
    })
  | (RenderAttemptBase & {
      status: 'failed';
      failedStage: VoiceQaStage;
      failureCode: VoiceRejectCode;
      evidence: Partial<VoiceAudioEvidence>;
      edits?: VoiceAudioEditRecord;
    });
