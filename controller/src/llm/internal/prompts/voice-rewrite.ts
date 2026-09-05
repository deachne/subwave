// One-shot broadcast copy rewrite. The model sees failed rule IDs and opaque
// fact tokens — not a request to improve the content generally, and never a
// source body.

export function voiceRewriteSystem(): string {
  return [
    'You write plain broadcast copy only.',
    'Return the revised line and nothing else.',
    'No labels, markdown, stage directions, or commentary.',
  ].join(' ');
}

export function voiceRewritePrompt(
  tokenizedText: string,
  failedRuleIds: readonly string[],
): string {
  const rules = failedRuleIds.length ? failedRuleIds.join(', ') : '(none)';
  return [
    'Revise this radio line so it passes the failed rules.',
    'Change phrasing only.',
    'Do not add a fact, number, named entity, attribution, or time.',
    'Keep every token that looks like [[FACT_n_xxxxxxxx]] exactly as written.',
    'Required tokens must appear exactly once; do not invent tokens.',
    `Failed rules: ${rules}`,
    '',
    tokenizedText,
  ].join('\n');
}
