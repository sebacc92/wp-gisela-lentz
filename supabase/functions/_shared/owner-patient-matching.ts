export type OwnerPatientCandidate = { id: string; name: string };

export type OwnerPatientMatch = {
  kind: "exact" | "suggestions" | "none";
  candidates: OwnerPatientCandidate[];
};

const MAX_QUERY_LENGTH = 60;
const MAX_QUERY_TOKENS = 10;
const MAX_NAME_LENGTH = 200;
const MAX_NAME_TOKENS = 16;
const MAX_SUGGESTIONS = 5;

/** Canonical lookup form only. Always display the original stored name. */
export function normalizePatientName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[.,-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function nameTokens(
  value: string,
  maxLength: number,
  maxTokens: number,
): string[] | null {
  const trimmed = value.normalize("NFC").trim();
  if (
    trimmed.length < 2 || trimmed.length > maxLength ||
    !/^[\p{L}\p{M}\s'’.,-]+$/u.test(trimmed)
  ) return null;
  const normalized = normalizePatientName(trimmed);
  if (normalized.length < 2) return null;
  const tokens = normalized.split(" ");
  return tokens.length <= maxTokens ? tokens : null;
}

function containsAllTokens(query: string[], candidate: string[]): boolean {
  const remaining = [...candidate];
  for (const token of query) {
    const index = remaining.indexOf(token);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

/** Bounded optimal-string-alignment distance, including adjacent swaps. */
function tokenTypoDistance(left: string, right: string): number | null {
  if (left === right) return 0;
  const a = Array.from(left);
  const b = Array.from(right);
  const shortest = Math.min(a.length, b.length);
  if (shortest < 4) return null;
  const limit = shortest >= 8 ? 2 : 1;
  if (Math.abs(a.length - b.length) > limit) return null;
  const distance = Array.from(
    { length: a.length + 1 },
    () => Array<number>(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i += 1) distance[i]![0] = i;
  for (let j = 0; j <= b.length; j += 1) distance[0]![j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      distance[i]![j] = Math.min(
        distance[i - 1]![j]! + 1,
        distance[i]![j - 1]! + 1,
        distance[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]
      ) {
        distance[i]![j] = Math.min(
          distance[i]![j]!,
          distance[i - 2]![j - 2]! + 1,
        );
      }
    }
  }
  const result = distance[a.length]![b.length]!;
  return result <= limit ? result : null;
}

function suggestionDistance(query: string[], candidate: string[]): number | null {
  if (query.length > candidate.length) return null;
  const options = query.map((token) =>
    candidate.flatMap((candidateToken, index) => {
      const cost = tokenTypoDistance(token, candidateToken);
      return cost === null ? [] : [{ index, cost }];
    }).sort((a, b) => a.cost - b.cost)
  ).sort((a, b) => a.length - b.length);
  if (options.some((row) => row.length === 0)) return null;

  // Every supplied token must fit a DIFFERENT token in the stored name. In
  // particular, a common first name cannot excuse an unrelated last name.
  let best = 3;
  const visited = new Map<string, number>();
  function visit(rowIndex: number, used: number, cost: number): void {
    if (cost >= best) return;
    if (rowIndex === options.length) {
      best = cost;
      return;
    }
    const key = `${rowIndex}:${used}`;
    if ((visited.get(key) ?? 3) <= cost) return;
    visited.set(key, cost);
    for (const option of options[rowIndex]!) {
      const bit = 1 << option.index;
      if ((used & bit) === 0) {
        visit(rowIndex + 1, used | bit, cost + option.cost);
      }
    }
  }
  visit(0, 0, 0);
  return best <= 2 ? best : null;
}

/**
 * Only normalized whole-token matches are exact. Misspellings are suggestions
 * that the caller MUST confirm before reading or displaying patient details.
 */
export function matchOwnerPatients(
  query: string,
  candidates: OwnerPatientCandidate[],
): OwnerPatientMatch {
  const queryTokens = nameTokens(query, MAX_QUERY_LENGTH, MAX_QUERY_TOKENS);
  if (!queryTokens) return { kind: "none", candidates: [] };
  const seen = new Set<string>();
  const directory = candidates.flatMap((candidate, index) => {
    if (!candidate.id || seen.has(candidate.id)) return [];
    const tokens = nameTokens(candidate.name, MAX_NAME_LENGTH, MAX_NAME_TOKENS);
    if (!tokens) return [];
    seen.add(candidate.id);
    return [{
      candidate: { id: candidate.id, name: candidate.name },
      tokens,
      index,
    }];
  });
  const exact = directory.filter(({ tokens }) =>
    containsAllTokens(queryTokens, tokens)
  );
  if (exact.length > 0) {
    return { kind: "exact", candidates: exact.map(({ candidate }) => candidate) };
  }
  const suggestions = directory.flatMap(({ candidate, tokens, index }) => {
    const distance = suggestionDistance(queryTokens, tokens);
    return distance === null ? [] : [{
      candidate,
      distance,
      extraTokens: tokens.length - queryTokens.length,
      index,
    }];
  }).sort((a, b) =>
    a.distance - b.distance || a.extraTokens - b.extraTokens || a.index - b.index
  ).slice(0, MAX_SUGGESTIONS).map(({ candidate }) => candidate);
  return {
    kind: suggestions.length > 0 ? "suggestions" : "none",
    candidates: suggestions,
  };
}
