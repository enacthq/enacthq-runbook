---
title: API Integration Template
description: Template for documenting external API integrations
---

# API Integration: [Service Name]

<!-- ← CUSTOMIZE: Copy this template for each integration -->

## Overview

| Field | Value |
|-------|-------|
| **Service** | [Name of external service] |
| **Type** | REST API / GraphQL / SOAP |
| **Environment** | Production / Staging |
| **Documentation** | [Link to vendor docs] |

## Authentication

- **Method**: API Key / OAuth 2.0 / Basic Auth
- **Credentials Location**: Secrets vault path
- **Rotation Schedule**: Quarterly / Annual

## Endpoints

### Primary Endpoint

```
POST https://api.vendor.com/v1/resource
Content-Type: application/json
Authorization: Bearer {token}
```

**Request**:
```json
{
  "field1": "value",
  "field2": 123
}
```

**Response** (200 OK):
```json
{
  "id": "abc123",
  "status": "success"
}
```

## Error Handling

| Code | Meaning | Action |
|------|---------|--------|
| 400 | Bad request | Check request format |
| 401 | Unauthorized | Refresh credentials |
| 429 | Rate limited | Back off and retry |
| 500 | Server error | Contact vendor |

## Rate Limits

- **Limit**: 1000 requests/minute
- **Throttling**: Automatic retry with exponential backoff

## Vendor Support

- **Support Portal**: [URL]
- **SLA**: 99.9% uptime
- **Contact**: See [Contacts](/content/reference/contacts/directory)
