// Settings-change subscriptions for the broadcast QA block. Follows time.ts:
// a pure module, no import of settings, so every writer (API, onboarding,
// restore) can emit from the one place the effective block actually changes.

import type { BroadcastQaSettings } from '../schemas/voice.js';
import { canonicalSha256 } from '../util/canonical-json.js';

type BroadcastQaListener = (qa: BroadcastQaSettings) => void;
const listeners = new Set<BroadcastQaListener>();
let lastHash = '';

export function onBroadcastQaChange(fn: BroadcastQaListener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emitBroadcastQaChange(qa: BroadcastQaSettings): void {
  const hash = canonicalSha256(qa);
  if (hash === lastHash) return;
  lastHash = hash;
  for (const fn of listeners) {
    try { fn(qa); } catch { /* subscriber's problem */ }
  }
}

export function resetBroadcastQaChangeForTests(): void {
  lastHash = '';
  listeners.clear();
}
