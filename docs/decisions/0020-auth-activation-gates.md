# 0020: authentication activation gates

Status: accepted.

Authentication activates in stages: route gate, explicit Principal resolution,
authorization, then an atomic rate-limit decision. A protected route must not
perform durable work before all gates pass. Rate limiting uses the existing
Redis adapter atomically; Redis outage behavior is explicit per operation and
defaults to a safe, public `503` rather than silently allowing an unbounded
auth surface. No auth route implementation is part of this policy change.

Acceptance criteria:

- Given an unauthenticated protected request, should stop at the route gate.
- Given an authenticated request, should resolve a Principal before checking
  authorization and should reject insufficient permissions.
- Given a rate-limit decision, should update and evaluate the limit atomically.
- Given a limiter outage, should follow the operation's documented fail-closed
  behavior and never pretend the check succeeded.
