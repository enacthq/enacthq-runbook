---
title: "DigitalOcean Managed PostgreSQL — Basic Process"
description: "What you actually need to know to create, connect to, and operate a DO managed PostgreSQL cluster via API. Token scopes, credential lifecycle, CA cert retrieval, and the operator escape hatches."
stack: "DigitalOcean Managed Database (PostgreSQL 16+), godo Go SDK, doctl CLI"
audience: "Operators provisioning DBaaS PostgreSQL on DO via API or scripts"
updated: 2026-04-27
status: active
tags: ["digitalocean", "postgresql", "managed-database", "api", "tokens", "tls"]
---

# DigitalOcean Managed PostgreSQL — Basic Process

This procedure documents what you actually need to know to create, connect
to, and operate a DigitalOcean **managed** PostgreSQL cluster via the DO
API or via the `godo` Go SDK / `doctl` CLI on top of it.

Most of the friction here is **not** in the cluster lifecycle itself —
DO's managed-database product works well. The friction is concentrated
in API-token scope semantics that aren't documented in one place. This
document is that one place.

For the connection-time pattern (sslmode, container cert handling, etc.)
inside an application, see the canonical pattern doc:
`crucible/docs/patterns/managed-pg-from-container.md`. This procedure
covers the provisioning side.

## Lifecycle at a glance

```
   ┌────────────────────────────────────────────────────────────┐
   │ 1. Create cluster                                          │
   │    POST /v2/databases  (database:create)                   │
   │    Response includes: cluster ID, connection.user,         │
   │    connection.password, connection.uri  ← only             │
   │    populated if token has database:view_credentials        │
   └─────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────┐
   │ 2. Poll until online (5–8 min typical, up to ~20 min)      │
   │    GET /v2/databases/{id}  (database:read)                 │
   │    Watch status field → "online"                           │
   └─────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────┐
   │ 3. Fetch CA certificate                                    │
   │    GET /v2/databases/{id}/ca  (database:view_credentials)  │
   │    Empty payload = scope missing                           │
   │    Save as PEM, mode 0644                                  │
   └─────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────┐
   │ 4. Harden (one-time, as the admin user)                    │
   │    Connect with sslmode=verify-ca + the CA from step 3     │
   │    CREATE DATABASE <name>;                                 │
   │    CREATE USER <app> WITH PASSWORD '<random>';             │
   │    GRANT ALL PRIVILEGES ON DATABASE <name> TO <app>;       │
   │    ALTER DATABASE <name> OWNER TO <app>;                   │
   │    REVOKE CREATE ON SCHEMA public FROM PUBLIC;             │
   └─────────────────────────┬──────────────────────────────────┘
                             │
                             ▼
   ┌────────────────────────────────────────────────────────────┐
   │ 5. Lock down trusted sources                               │
   │    PUT /v2/databases/{id}/firewall  (database:update)      │
   │    Restrict to VPC CIDR only; remove 0.0.0.0/0 if present  │
   └────────────────────────────────────────────────────────────┘
```

## The single most important thing — `database:view_credentials`

DigitalOcean gates the credential payload of multiple endpoints on a
single scope: **`database:view_credentials`**.

Endpoints that require it (verified 2026-04):

| Endpoint | What's missing without `view_credentials` |
|---|---|
| `POST /v2/databases` (create) | `connection.user`, `connection.password`, `connection.uri` are empty in the response |
| `GET /v2/databases/{id}` | Same — `connection.user: null`, URI is `postgresql://:@host/...` |
| `GET /v2/databases/{id}/users/{name}` | Returns `{name, role, settings}` only — no `password` field |
| `GET /v2/databases/{id}/ca` | Returns `{"ca":{"certificate":""}}` (HTTP 200 with empty cert) |

**Behavior pattern**: HTTP 200 status, well-formed JSON, but the
credential-bearing fields silently empty. The endpoints don't reject
your request — they just return empty values where credentials would be.

If your code or scripts produce any of:

- `password authentication failed for user "doadmin"`
- `FATAL: no PostgreSQL user name specified in startup packet`
- `failed to connect to user= database=` (empty user, empty database)
- 0-byte CA cert files

…the most likely cause is **the token is missing `database:view_credentials`**,
not an actual API change. DigitalOcean has no API for introspecting
token scopes, so verifying a suspect token requires opening the token
in the DO control panel UI.

## Token construction for managed-PG provisioning

Minimal scope set for a token that can create + manage + connect to a
managed PostgreSQL cluster in a VPC, **without** the ability to delete
infrastructure (which we recommend keeping out of provisioning tokens
per the SDR-0001 pattern):

| Category | Required scopes |
|---|---|
| **Database (the critical group)** | `database:read`, `database:create`, `database:update`, **`database:view_credentials`** |
| Account / metadata | `account:read`, `actions:read`, `regions:read`, `sizes:read` |
| VPC (if cluster lives in a VPC) | `vpc:read` |
| Firewall (for trusted-sources lockdown) | `firewall:read`, `firewall:create`, `firewall:update` |
| Project (if assigning cluster to a DO project) | `project:read`, `project:create`, `project:update` |

Notes on construction:

- **Don't omit `database:view_credentials`.** It's easy to miss in DO's
  scope-selection UI (it lives under "Other Access" rather than the
  CRUD-shaped Read/Create/Update buckets), and the API-side failure mode
  is silent rather than 403 — see "Most important thing" above.
- **DO's UI ticks "Required Scopes" automatically** for some operations
  (e.g. `actions:read`, `regions:read`, `sizes:read` are auto-bundled
  alongside `droplet:read`). Don't fight it; just verify the saved token
  by reading it back — there is no API for this.
- **Tokens cannot be edited after creation.** If you missed a scope,
  you must cut a new token and rotate. There is no API for token CRUD
  at all (verified against the published DigitalOcean API reference).
- **Per-workspace tokens are good practice** — failing that, a single
  org-level token with the scopes above, regenerated on a 90-day cadence,
  is acceptable for small teams. The blast radius of a leaked
  provisioning token is "all DBs and droplets in the account."

## The `reset_auth` scope asymmetry

`POST /v2/databases/{id}/users/{username}/reset_auth` is documented
as requiring `database:update`. **In practice it returns HTTP 403 with
`database:update` alone** — observed against tokens that successfully
exercise every other `database:update` operation.

This endpoint appears to require a fully-scoped (account-admin-class)
token, not the standard `database:update`. The same asymmetry exists on
some Spaces operations (e.g. `space_key:create` auto-bundles other
scopes that don't appear in the dashboard's checklist).

**Operational implication**: don't rely on `reset_auth` as a recovery
path for stranded credentials in scripted workflows. If an admin
password becomes unrecoverable (e.g. captured-once-then-lost in the
Create response), the available paths are:

1. **DO web console** — always shows the password under "Connection
   details" → reveal icon. Web UI bypasses the API scope problem.
2. **Destroy + recreate the cluster** (with a token that does have
   `view_credentials`).

## Credential capture timing

For tokens that DO have `database:view_credentials`, the credential
fields are populated on every response that documents them. For the
other (more common) state, here's where credentials are exposed:

- **`POST /v2/databases` Create response**: `connection.uri` includes
  the password inline (URL-encoded). This is the most reliable single
  point of capture.
- **`GET /v2/databases/{id}`** (after online): `connection.user` and
  `connection.password` populated, plus the URI.
- **`GET /v2/databases/{id}/users/doadmin`**: `password` field
  populated.

If you're scripting provisioning and don't yet know the token's scope
state, **capture the Create response credentials immediately** — that's
the one moment they're guaranteed exposed under any working scope. Persist
them locally with appropriate file mode (`0600`); regenerate on cluster
recreation. Even with full scope, this is defense-in-depth: if scope
is later rotated off, your capture survives.

## CA certificate retrieval

The TLS CA certificate that DO uses to sign managed-PG cluster certs
lives at `GET /v2/databases/{id}/ca`. With `database:view_credentials`,
the response is:

```json
{"ca": {"certificate": "<base64-encoded-PEM>"}}
```

The base64 decodes to a standard X.509 PEM (typically ~1.5 KB).

**If `certificate` is the empty string**: token is missing
`view_credentials`. See "The single most important thing" above.

**Alternative if the API path is unavailable**: the DO control panel,
under the cluster's "Connection details" section, has a **Download CA
certificate** button that always works. Save the file at
`<workspace>/.enact/certs/do-pg-ca.pem` (or your equivalent) at mode
`0644`.

## Connecting to the cluster

For application-level connection patterns (cert-bake vs bind-mount,
`sslmode=verify-ca` rationale, container Dockerfile shape, etc.), see
`crucible/docs/patterns/managed-pg-from-container.md`.

The short version:

- **Use `sslmode=verify-ca`**, not `verify-full`. Connect via the
  **private hostname** (`private-*.db.ondigitalocean.com`) when running
  inside the cluster's VPC. The cert's CN matches the public hostname
  pattern, so `verify-full` fails the hostname check; `verify-ca`
  verifies the cert chain (which is what you actually need for MITM
  protection inside a private network).
- **Reference the CA cert** via `sslrootcert=<path>` in the connection
  string, where the path points to the in-container location of the CA
  PEM.

## Idempotency and re-runs

Managed-database creation **cannot be made idempotent at the API
level** — POSTing twice creates two clusters with sequential names.
Always check first:

- `GET /v2/databases?name=<your-cluster-name>` — if a cluster with the
  desired name already exists, reuse its ID.
- Track cluster identity in your local state so re-runs of your
  provisioning script detect the existing cluster instead of
  re-creating.

For the harden step (CREATE DATABASE / CREATE USER), use idempotent SQL
patterns:

```sql
SELECT 1 FROM pg_database WHERE datname = 'app';      -- check before CREATE DATABASE
SELECT 1 FROM pg_roles WHERE rolname = 'app';         -- check before CREATE USER
```

`CREATE DATABASE` and `CREATE USER` are not transactional; running them
twice errors out. The select-then-conditionally-create pattern handles
the re-run case cleanly.

## Polling timeout — capture before you lose it

DO clusters typically come online in 5–8 minutes. Edge cases push to
20+ minutes (regional load, plan upgrades, transient platform issues).

**If your polling times out and you discard the Create response**, the
credentials in that response are gone. Subsequent `GET` calls return
the cluster object but no credentials (unless your token has
`view_credentials`). The cluster will eventually come online; your
credential capture won't.

Defensive pattern: **persist Create-response credentials to local state
before polling**, not after. If polling times out, the cluster eventually
comes online and your local state still has the credentials. Worst
case: re-poll with `databases:read` scope until you see `status:
"online"`, then proceed; no credential refetch needed.

## Common operator pitfalls

| Symptom | Likely cause | Fix |
|---|---|---|
| 403 on `POST /databases` | Missing `database:create` scope | Cut new token with the scope set above |
| `connection.user: null` on Get | Missing `database:view_credentials` | Cut new token; see scope construction |
| `/ca` returns empty string | Same — missing `view_credentials` | Same |
| `reset_auth` returns 403 with `database:update` | Endpoint requires fully-scoped account access | Use DO console to reveal password, or destroy+recreate |
| Cluster "online" but `connection.uri` is `postgresql://:@host/...` | Token didn't have `view_credentials` at create time, credentials were never captured | DO console; or destroy+recreate with a properly-scoped token |
| `pg_hba.conf no entry for host` on connect | Trusted sources don't include the connecting source | Add the source (or VPC CIDR) via `PUT /firewall` |
| `password authentication failed` despite correct password | Password contains URL-reserved chars (`@:/?#%`) and was not URL-encoded | Use `url.URL{User: url.UserPassword(...)}` (Go) or equivalent in your language |
| `verify-full` fails hostname check from inside VPC | Connecting via private hostname, cert CN is public | Use `sslmode=verify-ca` instead — see connection pattern doc |

## Cost notes

| Tier | Approximate $/mo | Use case |
|---|---|---|
| `db-s-1vcpu-1gb` | ~$15 | Smallest viable; light app, dev/staging, small team's IdP DB |
| `db-s-1vcpu-2gb` | ~$30 | Production-light; small SaaS workload |
| `db-s-2vcpu-4gb` | ~$60 | Production; non-trivial concurrency |

PITR (point-in-time recovery) is included in all tiers — that's the
usual rationale for choosing managed over self-hosted for small
deployments.

## Related references

- **Connection pattern**:
  `crucible/docs/patterns/managed-pg-from-container.md` — the
  application-side complement to this doc (cert-bake, sslmode rationale,
  Dockerfile shapes).
- **DO API reference (databases)**: searchable in `~/docs/refbolt`
  under `cloud-infra/digitalocean-api/<date>/reference/api/reference/databases/`.
- **godo SDK**: `github.com/digitalocean/godo` — `Databases.Create`,
  `Databases.Get`, `Databases.GetUser`, `Databases.GetCA`,
  `Databases.UpdateFirewallRules` are the relevant calls.
- **doctl**: `doctl databases create|get|connection|user|firewall` covers
  the same surface from the CLI.
- **Token UI**: https://cloud.digitalocean.com/account/api/tokens —
  the only place to inspect or modify token scopes.
