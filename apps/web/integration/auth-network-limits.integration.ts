import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { requireTestServices } from '@offense-demo/config';
import { createCeilingFlows, GLOBAL_MINUTE } from './auth-ceiling-helpers';
import { elapse, statuses } from './auth-rate-limit-helpers';
import { CLIENT_IP_HEADER } from '../src/features/auth/client-ip';
import { MAGIC_LINK_NETWORK_RULES } from '../src/features/auth/rate-limit';

/**
 * AUTH-3.10 (DEC-78): Better Auth keys an IPv6 client by its /64, so one
 * attacker with a /48 is 65,536 clients, each allowed 3 magic-link requests
 * a minute: about 3,277 a second, more than it takes to hold the handed-off
 * work's pool full and shed real users' sign-in mail (ADR 0025). The
 * aggregate buckets cap each /56, /48 and IPv4 /24, so that flood is
 * refused at the gate. Each flood here comes from one network, on the
 * composed app at production bounds with real services, and each bucket
 * has a flood that only it stops.
 */
requireTestServices(process.env);
setupRitewayBun();

const {
  accounts,
  testApp,
  mailbox,
  fresh,
  magicLink,
  elapseGlobalMinute,
  settled,
} = createCeilingFlows();

/** A Resend-like round trip, so every real send holds its slot a while. */
const PROVIDER_ROUND_TRIP_MS = 300;

/** 65,536 /64s × 3 a minute ÷ 60: what one /48 can send past the /64 buckets. */
const SINGLE_48_RATE = 3_277;
const FLOOD_SECONDS = 10;

/** One magic-link request from a given client, built directly (no harness client). */
const fromClient = (email: string, client: string) =>
  testApp.routes.auth.POST(
    new Request(`${testApp.origin}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: testApp.origin,
        [CLIENT_IP_HEADER]: client,
      },
      body: JSON.stringify({ email }),
    }),
  );

/** The /64 number `index` of the /48 2001:db8:77::/48, as a client address. */
const in48 = (index: number) =>
  `2001:db8:77:${(index & 0xffff).toString(16)}::1`;

/** Requests over the /56 2001:db8:88:ab00::/56: its 256 /64s, 3 each. */
const in56 = (index: number) =>
  `2001:db8:88:ab${(index & 0xff).toString(16).padStart(2, '0')}::1`;

/** Requests over the IPv4 /24 203.0.113.0/24: its 254 hosts, 3 each. */
const in24 = (index: number) => `203.0.113.${(index % 254) + 1}`;

const pendingWork = () => testApp.app.auth().pendingWork();

describe('AUTH-3.10 aggregate magic-link limits per network', () => {
  test('a single-/48 flood at the full rate loses no real sign-in mail from outside it', async () => {
    await elapseGlobalMinute();
    const existing: string[] = [];
    for (let index = 0; index < 10; index += 1)
      existing.push((await accounts.signUp()).email);
    await settled();
    mailbox.setLatency(PROVIDER_ROUND_TRIP_MS);
    const before = mailbox.mails.length;
    let peak = 0;
    let sampling = true;
    const sample = () => {
      peak = Math.max(peak, pendingWork());
      if (sampling) setImmediate(sample);
    };
    sample();
    const total = SINGLE_48_RATE * FLOOD_SECONDS;
    const flood: Promise<Response>[] = [];
    const signIns: Promise<Response>[] = [];
    const started = performance.now();
    const { events } = await testApp.withLoggedEvents(async () => {
      for (let index = 0; index < total; index += 1) {
        const due = started + (index * 1000) / SINGLE_48_RATE;
        const wait = due - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        flood.push(fromClient(fresh(), in48(index)));
        // One real sign-in a second, from a client outside the /48.
        if (index % SINGLE_48_RATE === Math.floor(SINGLE_48_RATE / 2))
          signIns.push(magicLink(existing[signIns.length] as string));
      }
      return Promise.all([...flood, ...signIns]);
    });
    const achievedRate = total / ((performance.now() - started) / 1000);
    sampling = false;
    await settled();
    mailbox.setLatency(0);
    const mailed = mailbox.mails
      .slice(before)
      .filter(({ to }) => existing.includes(to)).length;
    const floodStatuses = statuses(await Promise.all(flood));

    assert({
      given: `${total} magic-link requests from every /64 of one /48 at ${SINGLE_48_RATE}/s (achieved ${achievedRate.toFixed(0)}/s), a ${PROVIDER_ROUND_TRIP_MS} ms provider, and 10 real sign-ins from outside it`,
      should: `admit at most ${MAGIC_LINK_NETWORK_RULES.ipv6_48.max} of the flood in its minute and refuse the rest at the gate, shed nothing, and mail all 10 sign-ins`,
      actual: {
        floodAdmittedWithinLimit:
          (floodStatuses[200] ?? 0) <= MAGIC_LINK_NETWORK_RULES.ipv6_48.max,
        floodRefused: (floodStatuses[429] ?? 0) > 0,
        shed: events.filter((event) => event === 'auth.mail.shed').length,
        poolNeverNearFull: peak < 64,
        signInsMailed: mailed,
      },
      expected: {
        floodAdmittedWithinLimit: true,
        floodRefused: true,
        shed: 0,
        poolNeverNearFull: true,
        signInsMailed: 10,
      },
    });
  }, 600_000);

  test('a single /56 is admitted at most its own limit a minute', async () => {
    await elapse(testApp, GLOBAL_MINUTE);
    const responses = await Promise.all(
      Array.from({ length: 256 * 3 }, (_, index) =>
        fromClient(fresh(), in56(index)),
      ),
    );
    await settled();
    assert({
      given: 'all 256 /64s of one /56, 3 requests each, within a minute',
      should: `admit at most ${MAGIC_LINK_NETWORK_RULES.ipv6_56.max} and refuse the rest`,
      actual:
        (statuses(responses)[200] ?? 0) <= MAGIC_LINK_NETWORK_RULES.ipv6_56.max,
      expected: true,
    });
  }, 300_000);

  test('a single IPv4 /24 is admitted at most its own limit a minute', async () => {
    await elapse(testApp, GLOBAL_MINUTE);
    const responses = await Promise.all(
      Array.from({ length: 254 * 3 }, (_, index) =>
        fromClient(fresh(), in24(index)),
      ),
    );
    await settled();
    assert({
      given: 'all 254 hosts of one IPv4 /24, 3 requests each, within a minute',
      should: `admit at most ${MAGIC_LINK_NETWORK_RULES.ipv4_24.max} and refuse the rest`,
      actual:
        (statuses(responses)[200] ?? 0) <= MAGIC_LINK_NETWORK_RULES.ipv4_24.max,
      expected: true,
    });
  }, 300_000);
});
