// One logical rewrite per segment. Transport retry inside djText still counts
// as that one call. Tests inject rewriteFn so they never load the LLM stack.

import { voiceRewritePrompt, voiceRewriteSystem } from '../../llm/internal/prompts/voice-rewrite.js';

export const VOICE_REWRITE_MAX_OUTPUT_TOKENS = 250;
export const VOICE_REWRITE_KIND = 'voice.rewrite';

export type VoiceRewriteFn = (args: {
  system: string;
  prompt: string;
  maxOutputTokens: number;
  kind: string;
}) => Promise<string>;

export type VoiceRewriteInput = {
  tokenizedText: string;
  failedRuleIds: readonly string[];
  rewriteFn?: VoiceRewriteFn;
};

async function defaultRewriteFn(args: Parameters<VoiceRewriteFn>[0]): Promise<string> {
  const { djText } = await import('../../llm/sdk.js');
  return djText(args);
}

export async function rewriteDisplayText(input: VoiceRewriteInput): Promise<string> {
  const system = voiceRewriteSystem();
  const prompt = voiceRewritePrompt(input.tokenizedText, input.failedRuleIds);
  const fn = input.rewriteFn ?? defaultRewriteFn;
  const raw = await fn({
    system,
    prompt,
    maxOutputTokens: VOICE_REWRITE_MAX_OUTPUT_TOKENS,
    kind: VOICE_REWRITE_KIND,
  });
  return (typeof raw === 'string' ? raw : '').trim();
}
