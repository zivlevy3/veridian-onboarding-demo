# Onboarding Platform

AI-generated, personalized (2-month) onboarding plans, built on the Veridian org data.

## Structure

- `docs/PROJECT-README.md` — project seed / decisions from the discovery phase
- `docs/onboarding-framework.md` — the onboarding methodology (17 sections, 6 parts) that agents will build plans from
- `data/Veridian_Master_Data_Pack_v1.xlsx` — source of truth for org data (Employees, Departments, Teams, Offices, Products, Systems, Training Catalog, Policies, Glossary, FAQ, Career Levels, Roles)
- `db/schema.sql` — SQLite schema mirroring the workbook sheets
- `scripts/import-veridian.js` — reads the xlsx and rebuilds `db/veridian.sqlite` from scratch
- `db/veridian.sqlite` — generated (gitignored); run the import script to create it

## Setup

```bash
npm install
npm run import
```

Requires Node 22.5+ (uses the built-in `node:sqlite` module — no native build step, no Python needed).

## Status

Step 1 (repo + data schema + import script) is done. Next: an adapter layer over this DB for the onboarding agents (process expert, ops agent, content writer) described in `docs/onboarding-framework.md`.
