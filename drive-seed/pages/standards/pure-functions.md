# Pure Functions

Pure functions are the default, not the aspiration. Same inputs, same
outputs — every time, on every machine.

- No ambient reads inside domain, protocol and feature logic: no clock,
  no environment variables, no randomness, no filesystem or network.
- Effects live at the edges: route handlers and adapters. Time, IDs and
  resources are injected as explicit arguments; nothing pulls globals
  (`@{{name}}/clock` supplies the system and deterministic implementations).
- Rejected operations must leave state unchanged (atomicity is part of
  purity's contract).
- Domain invariants live in the domain packages; adapters never decide
  domain rules; rows are persistence, never domain entities.

The test for every new abstraction: could you call it twice with the same
arguments and prove the second call was redundant? If not, the effect needs
to move to an edge.
