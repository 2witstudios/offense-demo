import { assert, describe, setupRitewayBun, test } from 'riteway/bun';
import { answerUnavailableOnThrow } from './form-action';

setupRitewayBun();

type Answer = { readonly echo: string; readonly unavailable?: true };

const posted = (echo: string) => {
  const form = new FormData();
  form.set('echo', echo);
  return form;
};

const unavailable = (form: FormData): Answer => ({
  echo: String(form.get('echo')),
  unavailable: true,
});

describe('answerUnavailableOnThrow', () => {
  test('passes the action and its answer through', async () => {
    const seen: [Answer, string][] = [];
    const action = async (state: Answer, form: FormData): Promise<Answer> => {
      seen.push([state, String(form.get('echo'))]);
      return { echo: `answered ${String(form.get('echo'))}` };
    };
    const safe = answerUnavailableOnThrow(action, unavailable);
    assert({
      given: 'an action that answers',
      should: 'call it with the state and form and return its answer',
      actual: [await safe({ echo: 'before' }, posted('ada')), seen],
      expected: [{ echo: 'answered ada' }, [[{ echo: 'before' }, 'ada']]],
    });
  });

  test('a call that fails in transport is the unavailable answer for the posted form', async () => {
    const safe = answerUnavailableOnThrow<Answer>(
      () => Promise.reject(new TypeError('Failed to fetch')),
      unavailable,
    );
    assert({
      given: 'an action call that rejects, as a dropped connection does',
      should: 'answer unavailable with the posted value, never reject',
      actual: await safe({ echo: 'before' }, posted('ada')),
      expected: { echo: 'ada', unavailable: true },
    });
  });
});
