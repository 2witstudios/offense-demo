import { expect } from 'bun:test';
import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { sequentialId } from '@offense-demo/clock';
import { readAuthConfig } from '@offense-demo/config';
import { createRecordingLogger } from '../../server/test-loggers.test-support';
import { authTestEnv, composeAuthServer } from './auth-server.test-support';
import type { AuthDeliveryLedger } from './mail-types';
import {
  createTerminalSender,
  DEV_MAIL_PREFIX,
  formatDevMail,
} from './terminal-mail';

setupRitewayBun();

const message = {
  to: 'player@offense-demo.example.com',
  subject: 'Sign in to Offense Demo',
  text: 'Open the link.\n\nSign in to Offense Demo: http://localhost:3000/auth/confirm?token=SECRETTOKEN\n\nFooter.',
  html: '<p>ignored</p>',
};

/** A destination that keeps every chunk written to it. */
const recordingDestination = () => {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => void chunks.push(chunk) };
};

/** The development configuration with no Resend credential (ADR 0050). */
const terminalConfig = () => {
  const env: Record<string, string | undefined> = {
    ...authTestEnv,
    NODE_ENV: 'development',
  };
  Reflect.deleteProperty(env, 'RESEND_API_KEY');
  Reflect.deleteProperty(env, 'AUTH_EMAIL_FROM');
  return readAuthConfig(env);
};

describe('terminal mailer (ADR 0050)', () => {
  test('frames the message with the recipient, subject, link and body', () => {
    const lines = formatDevMail(message).trimEnd().split('\n');
    assert({
      given: 'a sign-in message',
      should: 'prefix every line with [dev-mail]',
      actual: lines.every((line) => line.startsWith(DEV_MAIL_PREFIX)),
      expected: true,
    });
    assert({
      given: 'a sign-in message',
      should: 'print the recipient, subject and the link on its own line',
      actual: lines.filter((line) =>
        /\[dev-mail\] (To|Subject|Link):/.test(line),
      ),
      expected: [
        '[dev-mail] To:      player@offense-demo.example.com',
        '[dev-mail] Subject: Sign in to Offense Demo',
        '[dev-mail] Link:    http://localhost:3000/auth/confirm?token=SECRETTOKEN',
      ],
    });
    assert({
      given: 'a sign-in message',
      should: 'include the plain-text body between two rules, never the HTML',
      actual: {
        body: lines.includes('[dev-mail] Footer.'),
        html: lines.some((line) => line.includes('<p>')),
        framed: lines[0] === lines.at(-1) && lines[0]?.includes('---'),
      },
      expected: { body: true, html: false, framed: true },
    });
  });

  test('neutralizes terminal control characters', () => {
    const printed = formatDevMail({
      ...message,
      subject: 'Sign in\u001b[2J\u009b31m',
      text: 'line\rinjected',
    });
    assert({
      given: 'a message carrying ANSI escapes and a carriage return',
      should: 'print no control character except the line breaks',
      actual: [...printed].some((character) => {
        const code = character.charCodeAt(0);
        return code !== 10 && (code < 32 || (code >= 127 && code < 160));
      }),
      expected: false,
    });
  });

  test('writes one block per send and returns a local receipt', async () => {
    const destination = recordingDestination();
    const sender = createTerminalSender({
      nodeEnv: 'development',
      ids: sequentialId('mail'),
      destination,
    });
    const receipt = await sender.send(message);
    assert({
      given: 'one message sent through the terminal mailer',
      should: 'write exactly its framed block and return a dev-mail receipt',
      actual: { chunks: destination.chunks, receipt },
      expected: {
        chunks: [formatDevMail(message)],
        receipt: { providerMessageId: 'dev-mail-mail-1' },
      },
    });
  });

  test('refuses to exist outside development', () => {
    for (const nodeEnv of ['production', 'test', 'staging', ''])
      expect(() =>
        createTerminalSender({ nodeEnv, ids: sequentialId('mail') }),
      ).toThrow('The terminal mailer is development-only');
  });

  test('a magic-link request prints a working link and records the delivery', async () => {
    const destination = recordingDestination();
    const recorded: Array<{ providerMessageId: string }> = [];
    const ledger: AuthDeliveryLedger = {
      isSuppressed: async () => false,
      record: async (input) => void recorded.push(input),
    };
    const { recorded: logs, logger } = createRecordingLogger();
    const server = composeAuthServer({
      config: terminalConfig(),
      emailSender: createTerminalSender({
        nodeEnv: 'development',
        ids: sequentialId('mail'),
        destination,
      }),
      ledger,
      logger,
    });
    await server.instance.api.signInMagicLink({
      body: { email: 'player@offense-demo.example.com' },
      headers: new Headers({ origin: authTestEnv.PUBLIC_APP_URL }),
    });
    await server.settled();
    const printed = destination.chunks.join('');
    const link = /\[dev-mail\] Link: +(\S+)/.exec(printed)?.[1] ?? '';
    const token = new URL(link || 'http://invalid').searchParams.get('token');
    assert({
      given: 'a development sign-in request with no Resend key',
      should:
        'print one confirm link on this origin and record the receipt like a provider send',
      actual: {
        origin: link ? new URL(link).origin : '',
        hasToken: (token ?? '').length > 0,
        receipts: recorded.map((row) => row.providerMessageId),
        sentLogged: logs.some((entry) => entry.event === 'auth.mail.sent'),
      },
      expected: {
        origin: authTestEnv.PUBLIC_APP_URL,
        hasToken: true,
        receipts: ['dev-mail-mail-1'],
        sentLogged: true,
      },
    });
    assert({
      given: 'the structured logs of that request',
      should: 'never carry the printed link or its token',
      actual: JSON.stringify(logs).includes(token ?? 'no-token'),
      expected: false,
    });
  });

  test('a suppressed recipient prints nothing', async () => {
    const destination = recordingDestination();
    const server = composeAuthServer({
      config: terminalConfig(),
      emailSender: createTerminalSender({
        nodeEnv: 'development',
        ids: sequentialId('mail'),
        destination,
      }),
      ledger: { isSuppressed: async () => true, record: async () => {} },
    });
    await server.instance.api
      .signInMagicLink({
        body: { email: 'bounced@offense-demo.example.com' },
        headers: new Headers({ origin: authTestEnv.PUBLIC_APP_URL }),
      })
      .catch(() => undefined);
    await server.settled();
    assert({
      given: 'a suppressed recipient in development',
      should: 'honour suppression before the terminal mailer, as for Resend',
      actual: destination.chunks,
      expected: [],
    });
  });
});
