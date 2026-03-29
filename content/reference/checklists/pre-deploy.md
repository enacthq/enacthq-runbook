---
title: Pre-Deployment Checklist
description: Verification checklist before deploying to production
---

# Pre-Deployment Checklist

<!-- ← CUSTOMIZE: Adapt to your deployment process -->

## Code Readiness

- [ ] All tests passing in CI
- [ ] Code review approved
- [ ] No critical security findings
- [ ] Documentation updated

## Change Management

- [ ] Change ticket created and approved
- [ ] Stakeholders notified
- [ ] Deployment window confirmed
- [ ] Rollback plan documented

## Environment Verification

- [ ] Target environment healthy
- [ ] Dependencies available
- [ ] Configuration validated
- [ ] Secrets/credentials current

## Monitoring Readiness

- [ ] Dashboards accessible
- [ ] Alerts configured
- [ ] Log aggregation working
- [ ] On-call engineer aware

## Go/No-Go

| Criteria | Status |
|----------|--------|
| Tests passing | ⬜ |
| Approvals complete | ⬜ |
| Environment ready | ⬜ |
| Monitoring ready | ⬜ |
| Rollback tested | ⬜ |

**Decision**: ⬜ GO / ⬜ NO-GO

---

## Post-Deployment

See [Deployment Procedure](/content/procedures/deployment) for execution steps.
