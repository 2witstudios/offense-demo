/**
 * Untrusted PR text (titles, bodies, branch names) made safe to forward:
 * control and format characters stripped, length bounded, and likely
 * prompt injection flagged. Shared by the merge notifications and the
 * documentation pipeline, so neither imports the other.
 */
export const TEXT_RISKS = ['clean', 'flagged'] as const;
export type TextRisk = (typeof TEXT_RISKS)[number];

const CONTROL_AND_FORMAT_PATTERN = /(?!\n)[\p{Cc}\p{Cf}]/gu;

export function sanitizeUntrustedText(value: string, max = 4000): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(CONTROL_AND_FORMAT_PATTERN, '')
    .trim()
    .slice(0, max);
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget)\b[^.\n]*\b(?:instructions?|prompts?|rules?|constraints?)\b/i,
  /\bsystem\s*prompt\b/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+instructions?\b\s*:/i,
  /\b(?:reveal|print|show|expose|output|include)\b[^.\n]*\b(?:secrets?|tokens?|passwords?|credentials?|api[- ]?keys?|webhook\s+secrets?)\b/i,
];

export function flagPromptInjection(text: string): {
  readonly flagged: boolean;
  readonly reasons: readonly string[];
} {
  const reasons = INJECTION_PATTERNS.filter((pattern) =>
    pattern.test(text),
  ).map((pattern) => `matched injection pattern ${pattern.source}`);
  return { flagged: reasons.length > 0, reasons };
}

export type AssessedEventText = {
  readonly textRisk: TextRisk;
  readonly reasons: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly branch: string;
};

const FIELD_LIMITS = { title: 300, body: 4000, branch: 200 } as const;

export function assessEventText(input: {
  readonly title: string;
  readonly body?: string | null;
  readonly branch?: string | null;
}): AssessedEventText {
  const title = sanitizeUntrustedText(input.title, FIELD_LIMITS.title);
  const body = sanitizeUntrustedText(input.body ?? '', FIELD_LIMITS.body);
  const branch = sanitizeUntrustedText(input.branch ?? '', FIELD_LIMITS.branch);
  const reasons: string[] = [];
  for (const [field, value] of [
    ['title', title],
    ['body', body],
    ['branch', branch],
  ] as const) {
    const { flagged, reasons: fieldReasons } = flagPromptInjection(value);
    if (flagged) reasons.push(`${field}: ${fieldReasons.join('; ')}`);
  }
  return {
    textRisk: reasons.length > 0 ? 'flagged' : 'clean',
    reasons,
    title,
    body,
    branch,
  };
}
