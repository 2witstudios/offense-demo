import { redirect, RedirectType } from 'next/navigation';

/** What a form action answers when a hydrated page must navigate itself. */
export type MovedOn = { readonly next: string };

/**
 * Ends a form action by moving on to `to`, a local path the server chose.
 * A form posted without JavaScript gets a 303 to it. A hydrated page gets it
 * back as action state and navigates itself: `redirect()` there makes Next
 * 16 fetch `to` from the public origin with the browser's cookies, to inline
 * the next page (`createRedirectRenderResult` in
 * next/dist/server/app-render/action-handler.js), and log a raw TypeError
 * when that fails (ISSUE-80). Next marks a scripted call with its
 * `Next-Action` header, which a native form post never carries.
 */
export function moveOn(incoming: Headers, to: string): MovedOn {
  if (!incoming.has('next-action')) redirect(to, RedirectType.replace);
  return { next: to };
}
