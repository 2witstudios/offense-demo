import type { Instrumentation } from 'next';

// The app's logger, from validated config, is the one both hooks use. The
// process edge is imported lazily, keeping this file free of server code,
// and each import sits inside its NEXT_RUNTIME check: Next inlines that
// value per bundle, so the Edge bundle drops the Node-only server graph.

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { processApp } = await import('./server/process-app');
  // Provider-neutral spans bind to the host's OTel provider. Exporters belong to deployment.
  processApp().logger.log(
    'runtime.initialize',
    { operation: 'runtime.initialize' },
    'Application runtime initialized',
  );
}
export const onRequestError: Instrumentation.onRequestError = async (
  _error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { processApp } = await import('./server/process-app');
  const id = request.headers['x-request-id'];
  processApp().logger.log(
    'request.unhandled',
    {
      operation: 'request.unhandled',
      requestId: typeof id === 'string' ? id : undefined,
      route: context.routePath,
      errorCode: 'INTERNAL',
    },
    'Unhandled request failure',
  );
};
