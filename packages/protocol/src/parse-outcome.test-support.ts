import type { z } from 'zod';

/**
 * What a schema made of an input, as a value a RITEway assertion can name:
 * the parsed data on acceptance, the issue paths on rejection. A bare
 * `.success` boolean passes for the wrong reason as easily as the right one.
 */
export const parseOutcome = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success
    ? { data: result.data }
    : {
        issues: result.error.issues.map(
          (issue) => issue.path.map(String).join('.') || '(root)',
        ),
      };
};

/** What the schema made of each input, in order. */
export const parseEach = (schema: z.ZodType, inputs: readonly unknown[]) =>
  inputs.map((input) => parseOutcome(schema, input));

/** The outcome of inputs every one of which parses to itself. */
export const parsedUnchanged = (inputs: readonly unknown[]) =>
  inputs.map((input) => ({ data: input }));
