import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { extractIconNames } from './icon-references';

setupRitewayBun();

describe('extractIconNames', () => {
  test('reads literal icon names in every JSX form', () => {
    assert({
      given:
        'double quotes, single quotes, a braced literal, a template literal, and a multi-line tag',
      should: 'extract each name',
      actual: [
        extractIconNames('<Icon name="bell" size={16} />'),
        extractIconNames("<Icon name='gem' />"),
        extractIconNames("<Icon name={'quote'} />"),
        extractIconNames('<Icon name={`home`} />'),
        extractIconNames('<IconButton\n  label="Go"\n  name="swords"\n/>'),
      ],
      expected: [['bell'], ['gem'], ['quote'], ['home'], ['swords']],
    });
  });

  test('reads both arms of a ternary, typos included', () => {
    assert({
      given: 'ternaries in a JSX prop and in object data, one arm misspelled',
      should: 'extract both arms so the misspelling is checked',
      actual: [
        extractIconNames("<Stat icon={up ? 'chart' : 'chrat'} value={1} />"),
        extractIconNames("const row = { icon: open ? 'eye' : 'eey', n: 1 };"),
      ],
      expected: [
        ['chart', 'chrat'],
        ['eye', 'eey'],
      ],
    });
  });

  test('is not stopped by an arrow function earlier in the tag', () => {
    assert({
      given: 'an onClick arrow function before a misspelled name prop',
      should: 'still attribute the name to IconButton and extract it',
      actual: extractIconNames(
        '<IconButton onClick={() => go()} label="Alerts" name="bel" />',
      ),
      expected: ['bel'],
    });
  });

  test('reads icon and glyph props and data keys', () => {
    assert({
      given: 'a Panel icon prop, a glyph prop, and nav/tile data entries',
      should: 'extract each name',
      actual: [
        extractIconNames('<Panel icon="bolt" title="Recent" />'),
        extractIconNames('<ActionTile glyph="chart" href="/reports" />'),
        extractIconNames("[{ href: '/', icon: 'home', label: 'Home' }]"),
        extractIconNames("{\n  glyph: 'calendar',\n  title: 'Events',\n}"),
      ],
      expected: [['bolt'], ['chart'], ['home'], ['calendar']],
    });
  });

  test('ignores name props and keys that are not icons', () => {
    assert({
      given:
        'an Avatar name, an input name, a name data key, a non-literal name, a type annotation, and an assignment after an Icon',
      should: 'extract nothing',
      actual: [
        extractIconNames('<Avatar name="Alex Chen" size="md" />'),
        extractIconNames('<Icon name="bell" /><input name="query" />').slice(1),
        extractIconNames("{ name: 'Alex Chen', tier: 'diamond' }"),
        extractIconNames('<Icon name={icon} size={18} />'),
        extractIconNames('readonly icon: IconName;\nreadonly label: string;'),
        extractIconNames('<Icon name="bell" />;\nconst name = "Ada";').slice(1),
      ],
      expected: [[], [], [], [], [], []],
    });
  });
});
