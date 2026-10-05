/**
 * Test support for capturing the production Resend sender's HTTP call: the
 * message it put on the wire, or undefined for any other request (which the
 * capturing fetch passes to the network).
 */
export const resendRequest = (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url !== 'https://api.resend.com/emails') return undefined;
  const body = JSON.parse(String(init?.body)) as {
    to: string[];
    subject: string;
    text: string;
    html: string;
  };
  return {
    to: body.to[0] ?? '',
    subject: body.subject,
    text: body.text,
    html: body.html,
    idempotencyKey: new Headers(init?.headers).get('idempotency-key') ?? '',
  };
};
