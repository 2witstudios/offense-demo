import { toPublicError } from '@offense-demo/errors';
import { requestId } from '@offense-demo/observability';

type Handler = (request: Request) => Promise<Response>;

/**
 * Binds route handlers to a lazily resolved route table, so importing a
 * route module (as `next build` does) builds and dials nothing. A table
 * that cannot be built (invalid configuration) still answers through the
 * public error contract, with a correlation id and never the cause.
 */
export function createRouteBinder<Routes>(resolve: () => Routes) {
  return (pick: (routes: Routes) => Handler): Handler =>
    async (request) => {
      let handler: Handler;
      try {
        handler = pick(resolve());
      } catch (error) {
        const id = requestId(request.headers.get('x-request-id'));
        const mapped = toPublicError(error, id);
        return Response.json(mapped.body, {
          status: mapped.status,
          headers: { 'x-request-id': id, 'Cache-Control': 'no-store' },
        });
      }
      return handler(request);
    };
}
