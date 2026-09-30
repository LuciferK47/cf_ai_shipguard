# Demo Worker

A tiny Agents SDK Worker that ShipGuard can audit. It exists so the memory demo is reproducible:

| Ref | State | ShipGuard reports |
|---|---|---|
| `demo-broken` (git tag) | Seeded with deployment mistakes | 4 findings: a Durable Object binding whose class is never declared, a declared class that is never exported, `env.AI` used with no AI binding, and a secret-looking value in `vars` |
| `main` | Fixed by two edits (rename the declared class, add the AI binding) | 1 finding: the `WEBHOOK_SECRET` value in `vars` is still committed. ShipGuard reports 3 resolved, 1 still present |

Audit `https://github.com/LuciferK47/cf_ai_shipguard/tree/demo-broken/examples/demo-worker`, then the same URL with `main`, and ask ShipGuard what changed.

The secret value in `wrangler.jsonc` is a made-up placeholder, not a credential.
