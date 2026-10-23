# Pipeline

HD IT's Autotask opportunities as a Kanban board: drag deals between stages, edit close dates and probability, log notes, link tickets and quotes. Part of **HD IT Pulse**: inside Pulse it signs in with Microsoft 365 (Entra ID); on its own it still accepts the team password while that's switched on.

| | |
|---|---|
| `frontend/index.html` | The board (one page, vanilla JS). Opens on demo data when no API address is filled in. |
| `backend/` | One Azure Function (Node 22): sign-in, Autotask REST, Key Vault secrets. `npm test` |
| `backend/src/lib/pulse-auth.js` | Pulse (Entra ID) token checks, shared with the other Pulse apps |
| `infra/main.bicep` | Function App, Static Web App, Key Vault, storage, monitoring |
| `.github/workflows/deploy-test.yml` | Build, test and deploy to the test tenancy on every push to `main` |
| `docs/AZURE-SETUP.md` | Test environment: resources, one-off setup, secrets |
| `docs/ORIGINAL-SETUP-GUIDE.md` | The original hand-deployment guide (historical) |

Production (`rg-hdit-pipeline-prod-aue`, HD IT tenant) still runs v1.12.0 and is deployed by hand from the release zip. Move it to this pipeline once test is signed off.

Version: `CONFIG.APP_VERSION` in `frontend/index.html` and `version` in `backend/package.json`, with an entry in `CHANGELOG.md`, `frontend/changelog.html` and `BUILT_FOR` in both help pages.
