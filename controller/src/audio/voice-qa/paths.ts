// Resolve a VoiceArtifact.path through STATE_DIR. The stored value is always
// a relative id such as voice/artifacts/<auditId>-<hash-prefix>.wav — never
// an absolute host path.

import { isAbsolute, resolve, sep } from 'node:path';
import { STATE_DIR } from '../../config.js';
import { VOICE_ARTIFACT_RELATIVE_PATH_RE } from '../../schemas/voice.js';

export function resolveVoiceArtifactPath(
  relativePath: string,
  stateDir: string = STATE_DIR,
): string {
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!rel || rel.includes('\0') || isAbsolute(rel) || rel.includes('://')) {
    throw new Error('voice artifact path must be a STATE_DIR-relative id');
  }
  if (rel.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('voice artifact path must not traverse');
  }
  if (!VOICE_ARTIFACT_RELATIVE_PATH_RE.test(rel)) {
    throw new Error('voice artifact path must stay under voice/artifacts/');
  }
  const root = resolve(stateDir);
  const resolved = resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error('voice artifact path escaped STATE_DIR');
  }
  return resolved;
}
