// Local heuristic: ~4 chars per token for code/prose. Good enough for budgeting;
// the runner reports exact usage from the API response after the fact.
export function estimateTokens(input: string | number): number {
  const chars = typeof input === "string" ? input.length : input;
  return Math.ceil(chars / 4);
}

export function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
