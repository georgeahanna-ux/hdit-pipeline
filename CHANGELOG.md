# Changelog

All notable changes to the **Pipeline** app (Autotask Sales Opportunity Board).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and the project
uses semantic-style versioning (`MAJOR.MINOR.PATCH`). The version shown in the app header
is set by `CONFIG.APP_VERSION` in `index.html` — bump it whenever you add an entry here.

## [1.13.0] - 2026-10-23
### Added
- **HD IT Pulse sign-in (Entra ID).** Inside Pulse, Pipeline takes its access token from Pulse over
  `postMessage` (exact origins only) and the backend verifies it (`lib/pulse-auth.js`: signature,
  tenant, audience, `access_as_user` scope). Roles `Pipeline.User`, `Pipeline.Admin` and `Pulse.Admin`
  decide access and administrator. The person's Autotask resource is matched by email, or linked once
  (`GET /link/resources`, `POST /link`).
- `GET /health` (version, Key Vault secrets present, Pulse status).
- Same layout as Marketing ROI and Whitespace: `frontend/`, `backend/`, `infra/main.bicep`, and a GitHub
  Actions deploy to the test tenancy (`rg-hdit-pipeline-test-aue`). Tests with `node --test`.
### Changed
- API address, environment and Pulse address are filled in at deploy time (`scripts/build-frontend.mjs`);
  with none, the page opens on demo data. Content-Security-Policy added; only Pulse may frame Pipeline.
- Key Vault access uses the Function's managed identity; a missing secret reads as "not set up" instead
  of an error. The team password keeps working while `LEGACY_PASSWORD_LOGIN` is `on`.
### Removed
- The unused MSAL bundle and the `jwks-rsa` dependency from the earlier Microsoft sign-in attempt.

## [1.12.0] - 2026-06-24
### Changed
- The **Associate existing ticket** picker is now searchable (type to filter by ticket number or
  title) and shows a tidier list: completed/resolved tickets are excluded, only tickets created in
  the last 6 months are shown, and they're sorted by ticket number (newest first).

## [1.11.0] - 2026-06-24
### Changed
- **Associate existing ticket** now works entirely inside Pipeline. Instead of opening Autotask's
  selector popup (which couldn't commit when launched from an external tab), the button now opens
  an in-app picker of the opportunity's company tickets; choosing one links it to the opportunity
  directly via the Autotask API, and the card/detail update immediately.

## [1.10.0] - 2026-06-24
### Added
- Each opportunity card now shows a small **ticket icon** indicating whether it has a linked
  ticket — highlighted (with a count when there's more than one) if tickets are linked, faded if
  not.
- An **Associate existing ticket** button in the opportunity detail, next to "Create linked
  ticket", which opens Autotask's ticket selector scoped to the opportunity's company.

## [1.9.1] - 2026-06-24
### Fixed
- Sign-in errors now show the real reason. Previously any rejected login (wrong team password or
  wrong authenticator code) was reported as "Your session expired", which was confusing; the app
  now displays the actual message ("Incorrect password" / "Invalid authenticator code").

## [1.9.0] - 2026-06-24
### Added
- Optional **two-factor sign-in** using a shared team authenticator code (TOTP, the same standard
  as LastPass/Google Authenticator). When a TOTP secret is configured in Key Vault
  (`app-totp-secret`), the login asks for the current 6-digit code in addition to the team
  password. The code is held in LastPass alongside the team password. If no secret is configured,
  login behaves exactly as before (no second factor), so the feature is opt-in and can't lock
  anyone out by accident.

## [1.8.0] - 2026-06-24
### Added
- Search box in the top bar that filters the board by opportunity title as you type. The
  visible cards, the active-opportunity count and the weighted-pipeline total all update to
  reflect the search, and it works alongside the owner, client and period filters. A clear
  (×) button resets it.

## [1.7.0] - 2026-06-23
### Added
- In-app version number, shown in the header on both the sign-in screen and the board.
- This changelog.

## [1.6.0] - 2026-06-23
### Changed
- Replaced the placeholder brand mark with the HD IT logo in the top-left of the board and
  on the sign-in screen. The logo is embedded inline and sits on a white chip on the dark
  top bar so the navy mark stays legible.

## [1.5.0] - 2026-06-23
### Added
- Per-stage sort buttons for **Opportunity ID** and **Projected Close Date**, alongside the
  existing Value and Probability sorts. Undated opportunities sort to the bottom, and the
  stage header wraps the buttons to a second line when space is tight.

## [1.4.0] - 2026-06-23
### Added
- **Filter by opportunity owner** and **filter by client** in the top bar, populated
  automatically from the loaded opportunities.
- **Current Week / Last Week / Next Week** options on the period filter (grouped with the
  existing month options).
- **Monthly recurring revenue (MRR) totals per stage**, shown alongside the one-off totals
  in each stage header.
### Changed
- "Create linked ticket" now uses ticket category **108**.
- The activity feed in the opportunity detail now shows **human notes only** — automatic
  system/audit entries are filtered out.

## [1.3.0] - 2026-06-23
### Added
- **Win probability shown on each card**, next to the opportunity value.
- **Per-stage sort by probability**.

## [1.2.0] - 2026-06-23
### Added
- **Editable win probability** field in the opportunity detail, written back to Autotask.
### Changed
- The **Weighted pipeline** figure now counts **Stage 6 and Stage 7 opportunities only**
  (one-off value × probability), within the selected period.

## [1.1.0] - 2026-06-23
### Added
- **Latest human note shown on each card** (system-generated notes excluded).
- **Copyable linked-ticket numbers** in the opportunity detail, with a Copy button.

## [1.0.0] - Initial release
Consolidated foundation of the Pipeline app:
- Kanban board of active Autotask opportunities, organised by sales stage.
- Sign-in with a shared team password + pick-your-name resource picker (this replaced an
  earlier Microsoft 365 SSO model that failed on locked-down laptops); admin role granted
  via a resource-id list.
- Top bar with active-opportunity count and weighted pipeline.
- Period filter by projected close date; show/hide stages (remembered per browser).
- Per-stage sort by value, and per-stage totals.
- Opportunity detail: edit title, description and close date; company, owner, one-off value
  and MRR shown for reference; quote and linked-ticket deep links; create linked ticket;
  activity feed and add-note (written to Autotask, attributed to the signed-in person).
- Drag-and-drop to change an opportunity's stage, written back to Autotask.
- Hosted on Azure (Static Web App + Function App + Key Vault).

> This 1.0.0 entry consolidates the project's pre-changelog history. From 1.1.0 onward each
> release is tracked individually.
