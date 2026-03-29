---
title: Dashboards & Metrics
description: Key metrics and dashboard links for Enacthq Runbook
---

# Dashboards & Metrics

<!-- ← CUSTOMIZE: Add your monitoring URLs and KPIs -->

## Primary Dashboards

| Dashboard | URL | Purpose |
|-----------|-----|---------|
| System Health | [Grafana/Datadog URL] | Overall system status |
| Application Metrics | [URL] | Request rates, latencies |
| Error Tracking | [Sentry/Rollbar URL] | Exceptions and errors |
| Infrastructure | [URL] | CPU, memory, network |

## Key Performance Indicators

### Availability

| Metric | Target | Current |
|--------|--------|---------|
| Uptime | 99.9% | [Link to metric] |
| Error Rate | < 0.1% | [Link to metric] |
| P95 Latency | < 200ms | [Link to metric] |

### Business Metrics

| Metric | Target | Dashboard |
|--------|--------|-----------|
| Requests/sec | > 1000 | [Link] |
| Active Users | - | [Link] |
| Transaction Success | > 99.5% | [Link] |

## SLA Definitions

| Tier | Availability | Response Time |
|------|--------------|---------------|
| Critical | 99.99% | 15 min |
| Standard | 99.9% | 1 hour |
| Best Effort | 99% | 4 hours |

## Alert Thresholds

| Alert | Warning | Critical | Action |
|-------|---------|----------|--------|
| CPU | > 70% | > 90% | Scale or investigate |
| Memory | > 80% | > 95% | Check for leaks |
| Error Rate | > 1% | > 5% | Investigate immediately |
| Latency P95 | > 500ms | > 1s | Check dependencies |
