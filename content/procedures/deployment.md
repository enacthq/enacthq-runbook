---
title: Deployment Procedure
description: Standard deployment process for Enacthq Runbook
---

# Deployment Procedure

<!-- ← CUSTOMIZE: Replace with your deployment steps -->

## Objective

Deploy new code to production environment safely and reliably.

## Prerequisites

- [ ] Code reviewed and approved
- [ ] Tests passing in CI
- [ ] Change ticket approved
- [ ] Rollback plan documented

## Steps

### 1. Pre-deployment Checks

```bash
# Verify build status
./scripts/check-build-status.sh

# Expected output: "Build #123 - PASSED"
```

### 2. Create Deployment

```bash
# Trigger deployment
./scripts/deploy.sh --environment production --version v1.2.3
```

**Verification**: Deployment dashboard shows "In Progress"

### 3. Monitor Rollout

- Watch error rates in monitoring dashboard
- Check application logs for startup errors
- Verify health check endpoints responding

### 4. Post-deployment Validation

- [ ] Health checks passing
- [ ] Key user flows working
- [ ] Error rates within normal range
- [ ] Performance metrics stable

## Rollback

If issues are detected:

```bash
./scripts/rollback.sh --to-version v1.2.2
```

## Related

- [Pre-deploy Checklist](/content/reference/checklists/pre-deploy)
- [Incident Escalation](/content/incidents/escalation)
