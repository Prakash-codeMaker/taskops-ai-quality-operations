# TaskOps — AI Data Operations Platform

TaskOps is a portfolio-grade operations console for teams that manage AI data work. It brings task intake, reviewer assignment, independent review, quality scoring, adjudication, trace ingestion, evaluations and audit history into one workspace.

This repository is an **exact source export of the TaskOps Hatchable project (version 32)**, including the frontend, API handlers, SQL migrations, seed data and platform configuration. It is the real application source, not a mock-up or a fresh rewrite.

> **Runtime note:** this source currently targets Hatchable's serverless V8 runtime and SDK. It is not yet a drop-in local FastAPI/Docker application. See [Portability and local deployment](docs/PORTABILITY.md) before attempting to run it outside Hatchable.

## Product areas

- **Operations overview** — workload, status mix, approval metrics, throughput and recent activity.
- **Task queue** — create tasks, import CSV/JSON batches, filter work and inspect task details.
- **Assignment and review** — reviewer roster, task assignment, review submissions and controlled state transitions.
- **Quality system** — versioned weighted rubrics and deterministic scoring/evaluation workflows.
- **Adjudication and auditability** — review history, decision events and traceable outcomes.
- **Integrations** — scoped API keys and ingestion of operational traces.
- **Workspace collaboration** — organizations, workspaces, invitations, memberships and role management.
- **Exports** — structured task and evaluation exports.

The app uses synthetic sample records. Do not treat demo metrics as production results.

## Architecture

```text
Browser (static HTML / CSS / JavaScript)
                |
                | HTTPS / JSON
                v
       Hatchable API routes (V8)
                |
        Hatchable SDK boundary
          /             \
         v               v
   PostgreSQL        Auth / platform
   migrations        services / secrets
```

![TaskOps architecture](docs/architecture.svg)

### Repository layout

| Path | Purpose |
|---|---|
| `public/` | Main dashboard, login, team, evaluations and integrations pages; browser JS and styles |
| `api/` | API handlers for tasks, reviews, rubrics, evaluations, audit, workspaces and trace ingestion |
| `lib/` | Shared workspace authorization and query helpers |
| `migrations/` | Ordered PostgreSQL schema and invariant migrations |
| `seed.sql` | Synthetic demo data |
| `hatchable.toml` | Hatchable auth, AI and database access configuration |

## Data model and migrations

The migration sequence is intentionally ordered:

1. Core task, organization and reviewer schema
2. Security hardening
3. Workspace tenancy
4. Workspace collaboration
5. Quality evaluation
6. Trace integrations
7. Collaboration invariants
8. Workspace default rubric
9. Reviewer and workspace roles
10. Workspace member removal
11. Reviewer role invariant
12. Reviewer removal guard
13. Reviewer promotion policy
14. Review rubric provenance

Apply these migrations in lexical order on a compatible PostgreSQL database. Review the SQL and adapt platform-specific policies before applying it to a non-Hatchable environment.

## Running and deploying

### On the original Hatchable project

The live application is hosted at:

- App: https://taskops-ai-data.hatchable.site
- API health: https://taskops-ai-data.hatchable.site/api/health

The original Hatchable project owns its database, auth configuration and runtime. To redeploy within Hatchable, import the source files into a project, apply migrations and deploy through Hatchable.

### Outside Hatchable

A standalone deployment needs a portability pass first. The handlers import Hatchable SDK services (notably database and authentication helpers), and Hatchable enforces its own route contract. Follow [docs/PORTABILITY.md](docs/PORTABILITY.md) for the concrete conversion plan. Do not assume `npm install`, `node api/...` or `docker compose up` will work on this export unchanged.

## Security and configuration

- No production secrets or API keys are included in this repository.
- Keep secrets in the deployment platform's secret manager or environment.
- Preserve workspace scoping on every tenant-owned query.
- Keep API-key material hashed; never commit live integration credentials.
- Use synthetic data in screenshots, fixtures and public examples.
- Review authentication, authorization, CORS, rate limits and audit retention before production use.

## AI evaluation status

The quality rubric and deterministic evaluation path are available independently of an AI provider. The optional model-assisted judge is not a substitute for human approval and must not automatically transition tasks. Provider configuration is optional in the source configuration.

## Current limitations

- The code is coupled to Hatchable's runtime and SDK; standalone hosting requires adaptation.
- The repository export contains source and schema, not Hatchable's managed platform services or live credentials.
- No standalone FastAPI implementation or Docker deployment is claimed by this export.
- Synthetic sample data does not establish production quality or throughput.
- AI-assisted evaluation depends on a separately configured provider and should be validated against a human-labelled set.

## Contributing

Please include the affected workflow, migration impact, authorization implications and test evidence in pull requests. For workflow changes, verify both the allowed transition and the rejected transition.

## License

No license has been selected for this repository yet. Unless a license is added, standard copyright restrictions apply; do not assume the code is open source for reuse.
