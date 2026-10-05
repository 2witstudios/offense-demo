import { z } from 'zod';

/** What asking POST /api/projects for a project can end in. */
export type CreateOutcome =
  | { readonly kind: 'created' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'rate-limited' }
  | { readonly kind: 'unavailable' };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type CreateProject = (name: string) => Promise<CreateOutcome>;

/** The domain's name invariant (`projectInvariantIds.nameValid`). */
const NAME_INVARIANT = 'project.name.valid';

const createdBody = z.object({ project: z.object({ id: z.string() }) });
const refusalBody = z.object({
  error: z.object({ invariantId: z.string().optional() }),
});

const readJson = (response: Response): Promise<unknown> =>
  response.json().catch(() => undefined);

/** A 422 is a bad name only when it names the name invariant. */
const invariantOutcome = async (response: Response): Promise<CreateOutcome> => {
  const parsed = refusalBody.safeParse(await readJson(response));
  return parsed.success && parsed.data.error.invariantId === NAME_INVARIANT
    ? { kind: 'invalid' }
    : { kind: 'unavailable' };
};

/**
 * Creating a project over POST /api/projects. The body is exactly
 * `{ name }`: the route decides the owner from the session, judges the name
 * against the domain invariant and spends the per-member create ceiling. A
 * rejected body (400) or the name invariant (422) is a name to fix; the
 * ceiling (429) waits; anything else, a transport failure included, is
 * unavailable and never a success.
 */
export const createCreateProject =
  (fetchImpl: FetchLike): CreateProject =>
  async (name) => {
    let response: Response;
    try {
      response = await fetchImpl('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch {
      return { kind: 'unavailable' };
    }
    if (response.status === 201)
      return createdBody.safeParse(await readJson(response)).success
        ? { kind: 'created' }
        : { kind: 'unavailable' };
    if (response.status === 400) return { kind: 'invalid' };
    if (response.status === 422) return invariantOutcome(response);
    if (response.status === 429) return { kind: 'rate-limited' };
    return { kind: 'unavailable' };
  };
