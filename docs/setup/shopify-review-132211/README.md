# Shopify App Review 132211 — resubmission materials

Prepared locally. **Nothing here has been submitted, deployed or configured.**

The finding was requirement **1.2.1**: the Billing page showed several GOTCHA
plans and the reviewer could not confirm whether Shopify functionality was sold
outside Shopify Billing. The underlying cause was worse than presentation —
three of the four Connector-funded entitlements were granted and never read, so
an active Connector and a cancelled one produced identical access.

| File | What it is |
|------|------------|
| [01-billing-architecture.md](./01-billing-architecture.md) | Paste at the top of Test Instructions |
| [02-test-instructions.md](./02-test-instructions.md) | The final Test Instructions |
| [03-screencast-script.md](./03-screencast-script.md) | Shot-by-shot, one continuous take |
| [04-reviewer-account-checklist.md](./04-reviewer-account-checklist.md) | Verify immediately before submitting |
| [05-deployment-checklist.md](./05-deployment-checklist.md) | **Read first — enforcement is fail-closed** |
| [06-dashboard-checklist.md](./06-dashboard-checklist.md) | Manual Dashboard checks (read-only) |
| [07-policy-evidence-matrix.md](./07-policy-evidence-matrix.md) | Requirement → code → test → shot |
| [08-deployment-dry-run.md](./08-deployment-dry-run.md) | Expected before/after per store, read-only |

## No customer is at risk

The single connected store is **our own development store with a cancelled
subscription**, on a `poc` tenant. Switching its Shopify access off after
deployment is the correct behaviour, not an incident. **No grandfather grant is
needed or appropriate.** See `05-deployment-checklist.md` §0 and
`08-deployment-dry-run.md`.

## Code

Branch `fix/shopify-review-132211-split-billing`, commits `38c79ea4`,
`7bf8c018`, `51dcd96a`, `2dae9623`. No migrations.

*Context only: prior Shopify Support ticket 69897769. Neither it nor this
submission asks for a billing exemption.*
