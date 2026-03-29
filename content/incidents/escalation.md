---
title: Escalation Procedures
description: When and how to escalate incidents
---

# Escalation Procedures

<!-- ← CUSTOMIZE: Add your escalation paths and contacts -->

## Severity Levels

| Level | Definition | Response Time | Examples |
|-------|------------|---------------|----------|
| **P1** | Critical - Service down | 15 min | Complete outage, data loss |
| **P2** | High - Major degradation | 1 hour | Partial outage, slow response |
| **P3** | Medium - Minor impact | 4 hours | Feature broken, workaround exists |
| **P4** | Low - Minimal impact | Best effort | Cosmetic issues, minor bugs |

## Escalation Matrix

### P1 - Critical

1. **Immediately**: Page on-call engineer
2. **15 minutes**: If no response, page secondary
3. **30 minutes**: Escalate to engineering lead
4. **1 hour**: Notify stakeholders, consider exec briefing

### P2 - High

1. **Immediately**: Notify on-call via Slack/PagerDuty
2. **1 hour**: Escalate if no progress
3. **4 hours**: Engineering lead involvement

### P3/P4 - Medium/Low

1. Create ticket in tracking system
2. Assign to appropriate team
3. Follow normal sprint process

## Communication

### Internal Updates

| Audience | Channel | Frequency |
|----------|---------|-----------|
| Incident Team | War room/Slack | Continuous |
| Engineering | #incidents channel | Every 30 min |
| Leadership | Email/Slack | Hourly for P1 |

### External Communication

For customer-facing incidents:
1. Status page update within 15 minutes
2. Customer support briefed
3. Follow-up communication on resolution

## Post-Incident

1. **Immediate**: Confirm resolution and monitoring
2. **24 hours**: Draft incident report
3. **1 week**: Post-mortem meeting
4. **2 weeks**: Action items assigned and tracked

See [Post-Mortem Template](/content/incidents/post-mortem-template) for documentation format.
