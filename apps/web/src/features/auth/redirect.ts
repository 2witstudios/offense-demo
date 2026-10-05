import { appConfig } from '../../app-config';

const ORIGIN = 'http://local.invalid';

const hasControlOrBackslash = (value: string) =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f || character === '\\';
  });

/** Percent-decodes up to three layers so double-encoded bypasses surface. */
function decodeLayers(value: string): string[] | null {
  const layers = [value];
  for (let index = 0; index < 3; index += 1) {
    const last = layers[layers.length - 1] ?? '';
    let decoded: string;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      return null;
    }
    if (decoded === last) break;
    layers.push(decoded);
  }
  return layers;
}

const isLocalPath = (layer: string) =>
  layer.startsWith('/') &&
  !layer.startsWith('//') &&
  !hasControlOrBackslash(layer);

/**
 * Once dot segments are resolved every decoding layer must still be a
 * same-origin path, so `/..%2F..%2F//host` cannot become protocol-relative,
 * and no layer may carry a credential in its query.
 */
function staysLocal(layer: string): boolean {
  try {
    const url = new URL(layer, ORIGIN);
    return (
      url.origin === ORIGIN &&
      !url.pathname.startsWith('//') &&
      !url.searchParams.has('token')
    );
  } catch {
    return false;
  }
}

/**
 * Return destinations are local paths only. External URLs, protocol-relative
 * and backslash forms, encoded variants and token-bearing queries all fall
 * back, so a confirmation redirect can never leak or forward a credential.
 */
export function safeLocalDestination(
  value: string | null | undefined,
  fallback: string = appConfig.homeRoute,
): string {
  if (!value) return fallback;
  const layers = decodeLayers(value);
  return layers && layers.every(isLocalPath) && layers.every(staysLocal)
    ? value
    : fallback;
}

/** Routes that are never a place to return to: they would loop or misuse it. */
const NEVER_A_DESTINATION = /^\/(?:sign-in|auth|api)(?:\/|$)/;

/**
 * The paths a browser could actually land on for a local destination: its
 * pathname once dot segments resolve, and again after each layer of
 * percent-decoding (bounded, as in `safeLocalDestination`), so neither
 * `/app/../api` nor `/%73ign-in` hides a forbidden route.
 */
function resolvedPaths(destination: string): string[] {
  const paths: string[] = [];
  let layer = destination;
  for (let depth = 0; depth < 4; depth += 1) {
    paths.push(new URL(layer, ORIGIN).pathname);
    let decoded: string;
    try {
      decoded = decodeURIComponent(layer);
    } catch {
      break;
    }
    if (decoded === layer) break;
    layer = decoded;
  }
  return paths;
}

/**
 * As `safeLocalDestination`, but a destination that resolves to sign-in,
 * auth or api also falls back: those routes would loop a return trip or let
 * an emailed link's callback misuse them (ISSUE-167).
 */
export function returnableDestination(
  value: string | null | undefined,
  fallback: string = appConfig.homeRoute,
): string {
  const destination = safeLocalDestination(value, fallback);
  return resolvedPaths(destination).some((path) =>
    NEVER_A_DESTINATION.test(path),
  )
    ? fallback
    : destination;
}
