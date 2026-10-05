/** The minimal valid `readAuthConfig` environment, shared by `auth-config.test.ts` and `ops-probe-token.test.ts`. */
export const authEnv = {
  NODE_ENV: 'development',
  BETTER_AUTH_SECRET:
    '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
  RECIPIENT_HASH_SECRET:
    'b8a6a86e17fc0067bd98c85480bf6e6ee0d50b18dc11bd5dc6240453c40e8031',
  PUBLIC_APP_URL: 'https://offense-demo.example.com',
  RESEND_API_KEY: 're_test_000000000000000000000000',
  AUTH_EMAIL_FROM: 'Offense Demo <no-reply@offense-demo.example.com>',
};

/** Obvious placeholder fixture: a well-formed `whsec_` value, not a real signing secret. */
export const webhookSecret = `whsec_${Buffer.from('placeholder-webhook-signing-key').toString('base64')}`;

/** The message a rejected configuration throws, or `accepted`. */
export const failureOf = (read: () => unknown) => {
  try {
    read();
    return 'accepted';
  } catch (error) {
    return String(error);
  }
};
