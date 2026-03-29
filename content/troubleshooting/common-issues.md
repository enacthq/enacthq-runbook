---
title: Common Issues
description: Troubleshooting guide for frequent problems
---

# Common Issues

<!-- ← CUSTOMIZE: Add your common issues and solutions -->

## Connection Timeout

**Symptoms**:
- API calls failing with timeout errors
- Dashboard showing "Connection refused"
- Users reporting slow or unresponsive application

**Possible Causes**:
1. Database connection pool exhausted
2. Network connectivity issues
3. Service overloaded

**Resolution**:

1. Check database connections:
   ```bash
   ./scripts/check-db-connections.sh
   ```

2. Verify network connectivity:
   ```bash
   curl -v https://api.example.com/health
   ```

3. If overloaded, scale up:
   ```bash
   ./scripts/scale-service.sh --replicas 5
   ```

**Escalation**: If unresolved after 15 minutes, escalate to [on-call](/content/incidents/escalation).

---

## High Memory Usage

**Symptoms**:
- Memory alerts firing
- OOM kills in container logs
- Degraded performance

**Resolution**:

1. Identify memory-heavy processes:
   ```bash
   ./scripts/memory-report.sh
   ```

2. Check for memory leaks in recent deployments
3. Consider rolling restart if immediate relief needed

---

## Authentication Failures

**Symptoms**:
- Users unable to log in
- 401 errors in API responses
- Token validation failures

**Resolution**:

1. Verify auth service status
2. Check certificate expiration
3. Validate configuration

See [Auth Troubleshooting](/content/troubleshooting/auth-issues) for detailed steps.
