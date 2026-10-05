import { appConfig } from '../../src/app-config';

/**
 * The product name the app renders, read from the one place a project sets
 * it. Specs never spell it: the generator renames the template's
 * placeholder by context, and inside a regex (next to an anchor or an `i`
 * flag) it reads as an identifier or a slug, not the rendered name.
 */
export const displayName = appConfig.brand.displayName;

/** `displayName` as a RegExp source: a name may contain `.` or `&`. */
export const displayNamePattern = displayName.replace(
  /[.*+?^${}()|[\]\\]/g,
  '\\$&',
);
