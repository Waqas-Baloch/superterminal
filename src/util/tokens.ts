// Local heuristic: ~4 chars per token for code/prose. Used only to budget how
// much context goes into a manifest — never shown to the user.
export function estimateTokens(input: string | number): number {
  const chars = typeof input === "string" ? input.length : input;
  return Math.ceil(chars / 4);
}

