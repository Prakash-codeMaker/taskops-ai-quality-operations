# Portability and local deployment plan

## Current state

This export mirrors the original Hatchable TaskOps project. The frontend is static HTML/CSS/JavaScript, but the backend handlers target Hatchable's V8 runtime and import its SDK. The project also relies on Hatchable-managed authentication and PostgreSQL.

This means the repository is source-complete for the original platform, but **not yet a standalone application**. The Hatchable SDK is not interchangeable with Node's standard runtime.

## Required conversion work

### 1. Replace the SDK boundary

Inventory imports from `hatchable` in `api/` and `lib/`. Introduce local service modules with explicit interfaces:

- Database: replace `db.query` with a PostgreSQL client (for example `pg`) and preserve parameterized SQL.
- Authentication: replace `auth` calls with a real session/JWT provider; derive user identity only from verified credentials.
- Authorization: preserve workspace membership and role checks in a shared authorization layer.
- Secrets: replace `config.get` with environment variables or a secret manager.
- Storage: if file/object storage is added later, use an S3-compatible provider.
- Background jobs: replace Hatchable scheduler calls with a worker/queue system.

Do not mechanically replace imports without checking each call's semantics.

### 2. Adapt route contracts

Hatchable handlers use `export default async function (req, res)`, platform-provided request objects and declared `export const access` values. A standalone server must explicitly implement:

- HTTP method and path routing
- Request parsing and validation
- Authentication middleware
- Role and workspace authorization middleware
- Consistent error responses
- Request IDs and audit logging

Keep the existing public API paths where practical so the current browser application needs minimal changes.

### 3. Database migration

- Use PostgreSQL.
- Apply `migrations/*.sql` in lexical order.
- Review any Hatchable-specific policies, functions or identity assumptions.
- Configure a least-privilege database role.
- Verify that every task, reviewer, rubric, evaluation and audit query is scoped to the active workspace.
- Load `seed.sql` only into a development/demo database.

### 4. Frontend

The existing `public/` directory is static and can be served by a static web server or reverse proxy. Update API base paths only if the frontend and API are deployed on different origins. Configure CORS narrowly if they are separate.

### 5. Verification checklist

- [ ] Authentication: anonymous requests are rejected on protected routes.
- [ ] Authorization: a user in workspace A cannot read or mutate workspace B.
- [ ] Task lifecycle: invalid state transitions are rejected.
- [ ] Reviews: review submissions preserve rubric version and reviewer identity.
- [ ] Evaluations: deterministic scoring is repeatable for the same input and rubric.
- [ ] Audit: all consequential mutations write attributable events.
- [ ] Trace ingestion: scoped API keys cannot cross workspace boundaries.
- [ ] Exports: CSV/JSON output is scoped and does not leak secrets.
- [ ] Migrations: fresh database setup and upgrade path both succeed.
- [ ] Frontend: create, import, assign, review, adjudicate and export workflows work end-to-end.

## What is not included

This export does not include Hatchable's hosted runtime, its managed auth service, project secrets, deployment configuration outside the repository, or any private platform infrastructure. Those components must be replaced or provisioned separately for a self-hosted deployment.
