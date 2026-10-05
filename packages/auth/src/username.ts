/** 3-32 ASCII letters, digits, underscore or hyphen, checked before lowercasing. */
const USERNAME_SHAPE = /^[A-Za-z0-9_-]{3,32}$/;

export type UsernameParse =
  { readonly ok: true; readonly username: string } | { readonly ok: false };

/**
 * The single username rule shared by the sign-up form and the claim endpoint.
 * Validation runs on the trimmed input before case folding, so characters
 * that only become ASCII when lowercased (KELVIN SIGN) are refused.
 */
export function parseUsername(input: unknown): UsernameParse {
  if (typeof input !== 'string') return { ok: false };
  const trimmed = input.trim();
  return USERNAME_SHAPE.test(trimmed)
    ? { ok: true, username: trimmed.toLowerCase() }
    : { ok: false };
}
