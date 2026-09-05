// Runtime request/result types for broadcast voice QA. These carry a Queue
// Persona and therefore cannot live in schemas/voice.ts (mirrored modules
// may import only zod).
import type { Persona } from '../../broadcast/queue/types.js';
import type { RenderAttemptRecord } from '../../broadcast/voice-audit/types.js';
import type {
  BroadcastQaSettings,
  EcWarningCopyProof,
  FactLock,
  ProvenanceLease,
  ReviewedAssetWaiver,
  VoiceArtifact,
  VoiceDurationProfile,
  VoiceQaStage,
  VoiceRejectCode,
  VoiceRenderSnapshot,
} from '../../schemas/voice.js';

export type {
  BroadcastQaSettings,
  EcWarningCopyProof,
  FactLock,
  ProvenanceLease,
  ReviewedAssetWaiver,
  VoiceArtifact,
  VoiceDurationProfile,
  VoiceQaStage,
  VoiceRejectCode,
  VoiceRenderSnapshot,
};

export type VoiceLinkContext =
  | {
      style: 'natural';
      trackMetadataHash: string;
      artistLockId: string;
      titleLockId: string;
      currentIsOnAir: boolean;
      speakerPersonaId: string;
      speakerPersonaHash: string;
    }
  | {
      style: 'announce';
      trackMetadataHash: string;
      artistLockId: string;
      titleLockId: string;
      currentIsOnAir: boolean;
      speakerPersonaId: string;
      speakerPersonaHash: string;
      announceForm: 'this-is' | 'next-up';
      lastAiredLinkHash: string;
    };

export interface VoiceRenderRequest {
  auditId: string;
  traceId?: string;
  candidateId?: string;
  displayText: string;
  kind: string;
  profile: VoiceDurationProfile;
  persona?: Persona | null;
  legacyGainDb: number;
  automatic: boolean;
  rewriteAllowed: boolean;
  rewriteCount: 0 | 1;
  facts:
    | { sourceBacked: false; factLocks: FactLock[] }
    | {
        sourceBacked: true;
        factLocks: FactLock[];
        provenance: ProvenanceLease;
      };
  reviewedAsset?: ReviewedAssetWaiver;
  ecWarning?: EcWarningCopyProof;
  linkContext?: VoiceLinkContext;
}

export type VoiceRenderResult =
  | {
      ok: true;
      artifact: VoiceArtifact;
      attempts: RenderAttemptRecord[];
      auditPersisted: boolean;
    }
  | {
      ok: false;
      auditId: string;
      code: VoiceRejectCode;
      stage: VoiceQaStage;
      message: string;
      failedRuleIds: string[];
      attempts: RenderAttemptRecord[];
    };
