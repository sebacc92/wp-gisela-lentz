const encoder = new TextEncoder();

async function secretDigest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value)),
  );
}

function constantTimeDigestEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function secretMatches(
  providedSecret: string,
  expectedSecret: string,
): Promise<boolean> {
  const provided = providedSecret.trim();
  const expected = expectedSecret.trim();
  const [providedDigest, expectedDigest] = await Promise.all([
    secretDigest(provided),
    secretDigest(expected),
  ]);
  return (
    provided.length > 0 &&
    expected.length > 0 &&
    constantTimeDigestEqual(providedDigest, expectedDigest)
  );
}

export async function authorizeProcessorRequest(
  request: Request,
  expectedInternalSecret: string,
  expectedRecoverySecret: string,
): Promise<boolean> {
  const providedInternalSecret = request.headers.get("x-internal-secret") ?? "";
  const providedRecoverySecret = request.headers.get("x-recovery-secret") ?? "";

  // Evaluate both fixed-size digest comparisons before applying the OR. This
  // preserves the original internal credential while keeping recovery fully
  // namespaced and fail-closed when either environment value is absent.
  const [internalMatches, recoveryMatches] = await Promise.all([
    secretMatches(providedInternalSecret, expectedInternalSecret),
    secretMatches(providedRecoverySecret, expectedRecoverySecret),
  ]);
  return internalMatches || recoveryMatches;
}
