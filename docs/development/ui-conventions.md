# UI conventions

Rules every screen in `apps/web` follows. They sit beside the component
guidance in `apps/web/src/ui`; this page holds only the rules that have
caused defects when broken. Where the brand lives (palette, mark, fonts,
mail copy, contrast pairs) has its own guide: [branding](branding.md).

## Mutating forms work without JavaScript

Owner decision, 2026-09-23. Every form that changes state is a
real POST that works before hydration and with JavaScript off. Client
JavaScript only enhances it.

- The form posts to a Next server action (`<form action={serverAction}>`,
  usually through `useActionState`) or to a route that answers a form POST.
  An `onSubmit` handler that calls `preventDefault()` and does the work in
  `fetch` is not enough on its own. Before hydration the browser submits
  the bare `<form>` as a native GET to the current page. That drops the
  submission and puts the field values in the URL.
- Form data never lands in a URL: not in the action's redirect, a query
  string or a notice. A refusal comes back as action state, which renders
  the typed value again and the notice with it. Success moves on with a
  redirect to a page that needs nothing from the form.
- The server re-validates everything the browser sends back, including
  arguments bound with `.bind`: they round-trip through the page and are
  untrusted. The action runs the same gates as the equivalent API route:
  it calls that route's handler in process with the request's own headers
  (`inProcessFetch` in `apps/web/src/server/in-process-fetch.ts`). The
  username claim, the sign-in link request and the email change all work
  this way.
- An action that moves on ends with `moveOn` (`apps/web/src/server/form-action.ts`),
  never a bare `redirect()`. A form posted without JavaScript gets a 303;
  a hydrated page gets the destination back as action state and navigates
  itself. A `redirect()` in an action the page's script calls makes Next
  fetch the target from the public origin with the browser's cookies, and
  print a raw error when that fails.
- Every action body is capped at 16 KiB (`serverActions.bodySizeLimit` in
  `apps/web/next.config.ts`). Next reads and decodes the body
  before the action's own gates run, so a form that needs more (a file
  upload) needs its own route and a recorded decision, not a higher cap.
- A form's action state comes from `useFormAction`
  (`apps/web/src/ui/form-action/form-action.ts`), not a bare
  `useActionState`. With JavaScript on, the action is a fetch the page makes.
  If that fetch fails in transport (a dropped connection), the form answers
  its own unavailable state with the typed value kept, never the root error
  screen. The server render keeps the server action itself,
  because React renders the no-JavaScript POST only from a server action.
- A form that disables its controls while the answer is pending hands focus
  back with `useFocusAfterAnswer` from the same module. A disabled control
  drops focus to `<body>`, so each new answer owes focus until the state it
  settles into has rendered; the caller says when that is (`settled`), and
  focus then goes to the element that state names: the form's field, or the
  next step's heading when the answer leads to a new step. A
  target named before the answer settles may be about to unmount, as the
  inbox heading is when a resend is refused. The browser suite asserts
  `document.activeElement` after each answer, resends included
  (`e2e/answer-focus.e2e.ts`).
- JavaScript may add a local check before posting (`onSubmit` calling
  `preventDefault()` for a value that cannot be valid), pending states and
  focus handling. React runs the action only when `onSubmit` did not
  prevent the default.
- A choice that only navigates, such as "Not now", is a link (`<a href>`),
  not a button with an `onClick`, so it works before hydration too.
- No `loading.tsx` or `<Suspense>` fallback sits above a page with a form.
  Next streams such a page into a hidden node that only an inline script
  reveals, so without JavaScript the page never appears.
- Prove it in the browser suite with JavaScript actually off: a context
  with `javaScriptEnabled: false` runs no script at all, inline or bundled.
  Submit, then assert the outcome and a URL without the submitted values.
  Aborting only the script chunks is not enough, because inline scripts
  still run and reveal what a script-less browser never sees. See the
  "with JavaScript off" block in `apps/web/e2e/journey.e2e.ts`.

Forms that predate this rule are tracked as issues in the PageSpace `Issues`
list. Bring each one into line when you next change it.

## Reading data in a page

A server component reads data through the same API route the browser
would call, never by querying `@offense-demo/db` or deciding access itself.

- Call `readRoute` from `apps/web/src/lib/request-route.ts` with the bound
  route's GET handler and its path, for example
  `await readRoute((routes) => routes.sessions.GET, '/api/account/sessions')`.
  It runs that handler in process (`inProcessFetch`) with this request's
  own headers from `await headers()`, so the route's gates (session,
  rate limit, and `authorizeRequest` for a protected read, ADR 0048) run
  exactly as for the browser, and a denied read answers the same
  `NOT_FOUND` as a missing resource.
- The headers that describe the browser's navigation (`Origin`, `Referer`,
  `Sec-Fetch-*`) are dropped: the page may have been reached from another
  site's link, and the read is this server's own, answered only into that
  session's HTML.
- The page still calls `requireAccess` first, which redirects a visitor to
  sign-in and a provisional account to onboarding before any read.
- Pass the page's client components only what they render; for an access
  hint, run the decision on the server and pass a boolean
  (`{ canCreateProject }`), never loaded rows or deny facts.
- Writes stay server actions (see above). `readRoute` is GET only, and it is
  a process entry in `eslint.config.mjs`, the one page-side module besides
  the session read that may reach the process's route table.
