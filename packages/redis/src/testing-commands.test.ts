import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import './index';
import './presence-scripts';
import { commandRefusal } from './testing';
import { registeredScripts } from './script-registry';

setupRitewayBun();

// Any script the adapter registered: loading the modules above registers them.
const consumeScriptForTests = [...registeredScripts()][0] ?? '';
const NS = 't3-abcdefghij';

describe('commandRefusal: a namespace-anchored scan, whatever the pattern (ISSUE-274)', () => {
  const refused = (command: string, args: string[], scripts = false) =>
    commandRefusal(command, args, { scripts }) !== undefined;

  test('refuses every SCAN or KEYS that could match beyond one namespace', () => {
    const patterns = [
      '*',
      '**',
      '?*',
      '[a-z]*',
      'a*',
      't3-*',
      't3-a*',
      `${NS.slice(0, 7)}*`,
      '*:v1:*',
      '',
      `t3-*:${NS}`,
    ];
    const scans = patterns.map((pattern) =>
      refused('SCAN', ['0', 'MATCH', pattern, 'COUNT', '500']),
    );
    const keys = patterns.map((pattern) => refused('KEYS', [pattern]));

    assert({
      given:
        'SCAN and KEYS with every wildcard-only, character-class, short-prefix and empty pattern',
      should: 'refuse each, in both commands',
      actual: { scans, keys },
      expected: {
        scans: patterns.map(() => true),
        keys: patterns.map(() => true),
      },
    });
  });

  test('refuses a SCAN with no MATCH at all, in any case and option order', () => {
    assert({
      given: 'SCAN with no MATCH, lower case, and with COUNT first',
      should: 'refuse each: no MATCH means every key',
      actual: [
        refused('SCAN', ['0']),
        refused('scan', ['0', 'COUNT', '500']),
        refused('SCAN', ['0', 'COUNT', '500', 'TYPE', 'string']),
      ],
      expected: [true, true, true],
    });
  });

  test('ISSUE-269: every MATCH must be anchored, since Redis uses the last one', () => {
    const anchored = `${NS}:*`;
    assert({
      given:
        'SCAN with an anchored MATCH followed (or preceded) by a wildcard MATCH, in any case and with COUNT or TYPE between',
      should: 'refuse each: the last MATCH is the one Redis applies',
      actual: [
        refused('SCAN', ['0', 'MATCH', 't3-zzzzzz*', 'MATCH', '*']),
        refused('scan', ['0', 'match', anchored, 'match', '*']),
        refused('SCAN', ['0', 'MATCH', anchored, 'COUNT', '10', 'MATCH', '*']),
        refused('SCAN', [
          '0',
          'MATCH',
          '*',
          'TYPE',
          'string',
          'MATCH',
          anchored,
        ]),
        refused('SCAN', ['0', 'MATCH', anchored, 'MATCH', '**']),
      ],
      expected: [true, true, true, true, true],
    });
  });

  test('ISSUE-269: options are parsed the way Redis parses them, so nothing hides in one', () => {
    const anchored = `${NS}:*`;
    assert({
      given:
        'a MATCH with no pattern, an unknown option, a pattern that is itself named MATCH, and KEYS with a second argument',
      should: 'refuse each',
      actual: [
        refused('SCAN', ['0', 'MATCH']),
        refused('SCAN', ['0', 'MATCH', anchored, 'FOO', 'bar']),
        refused('SCAN', ['0', 'MATCH', 'MATCH']),
        refused('SCAN', ['0', 'COUNT']),
        refused('KEYS', [anchored, '*']),
      ],
      expected: [true, true, true, true, true],
    });
  });

  test('negative control: several MATCH options, all anchored, and TYPE or COUNT between, are allowed', () => {
    assert({
      given: 'two anchored MATCH options with COUNT and TYPE between them',
      should: 'allow it',
      actual: refused('scan', [
        '0',
        'MATCH',
        `${NS}:a*`,
        'COUNT',
        '500',
        'TYPE',
        'string',
        'match',
        `${NS}:b*`,
      ]),
      expected: false,
    });
  });

  test('negative control: a pattern anchored at one test namespace is allowed', () => {
    assert({
      given:
        'SCAN and KEYS matching one namespace, another id, a shard prefix, in any case and option order',
      should: 'allow all of them',
      actual: [
        refused('SCAN', ['0', 'MATCH', `${NS}:*`, 'COUNT', '500']),
        refused('scan', ['0', 'COUNT', '500', 'MATCH', `${NS}:v1:rl:*`]),
        refused('KEYS', [`${NS}:*`]),
        refused('keys', [`${NS}-wt-*`]),
      ],
      expected: [false, false, false, false],
    });
  });

  test('refuses database-wide and switching commands, and any command it does not know', () => {
    assert({
      given:
        'FLUSHDB, FLUSHALL, SELECT, SWAPDB, MOVE, CONFIG, DEBUG, SHUTDOWN, MONITOR, RANDOMKEY, DBSIZE and an invented command',
      should: 'refuse each: the allowlist is the only way in',
      actual: [
        'FLUSHDB',
        'flushall',
        'SELECT',
        'swapdb',
        'MOVE',
        'CONFIG',
        'DEBUG',
        'SHUTDOWN',
        'MONITOR',
        'RANDOMKEY',
        'DBSIZE',
        'NOTACOMMAND',
      ].map((command) => refused(command, ['0'])),
      expected: Array.from({ length: 12 }, () => true),
    });
  });
});

describe('Lua: a test can run only the scripts the adapter registered (ISSUE-274)', () => {
  const refused = (command: string, args: string[], scripts: boolean) =>
    commandRefusal(command, args, { scripts }) !== undefined;

  test('the raw wrapper refuses every script command', () => {
    assert({
      given: 'EVAL, EVALSHA, SCRIPT and FUNCTION on the wrapper a suite opens',
      should: 'refuse each, so no test can run Lua (FLUSHDB included)',
      actual: [
        refused('EVAL', ["redis.call('FLUSHDB')", '0'], false),
        refused('EVALSHA', ['abc', '0'], false),
        refused('SCRIPT', ['LOAD', 'return 1'], false),
        refused('FUNCTION', ['FLUSH'], false),
      ],
      expected: [true, true, true, true],
    });
  });

  test('the bounded wrapper runs a registered script and refuses any other', () => {
    assert({
      given:
        'the adapter’s own rate-limit script and a script that flushes the database, on the wrapper code under test gets',
      should:
        'allow the registered script (by EVAL or SCRIPT LOAD, and EVALSHA of a loaded one) and refuse the flushing one',
      actual: {
        registeredEval: refused(
          'EVAL',
          [consumeScriptForTests, '1', 'k'],
          true,
        ),
        registeredLoad: refused(
          'SCRIPT',
          ['LOAD', consumeScriptForTests],
          true,
        ),
        evalsha: refused('EVALSHA', ['abc', '1', 'k'], true),
        unregisteredEval: refused('EVAL', ["redis.call('FLUSHDB')", '0'], true),
        unregisteredLoad: refused(
          'SCRIPT',
          ['LOAD', "redis.call('FLUSHDB')"],
          true,
        ),
        scriptFlush: refused('SCRIPT', ['FLUSH'], true),
        functions: refused('FUNCTION', ['FLUSH'], true),
      },
      expected: {
        registeredEval: false,
        registeredLoad: false,
        evalsha: false,
        unregisteredEval: true,
        unregisteredLoad: true,
        scriptFlush: true,
        functions: true,
      },
    });
  });
});
