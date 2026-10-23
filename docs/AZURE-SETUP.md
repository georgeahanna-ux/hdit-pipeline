# Azure setup: Pipeline (test)

How the test environment is put together, the one-off steps before the first deployment, and the steps after it. It's the same pattern as Marketing ROI and the Whitespace Matrix. Production (`rg-hdit-pipeline-prod-aue` in the HD IT tenant) is separate and still deployed by hand.

## What lives where

| Resource | Name | Notes |
|---|---|---|
| Resource group | `rg-hdit-pipeline-test-aue` | Australia East. Created by the setup script. |
| Deploy identity | `id-hdit-pipeline-deploy-test-aue` | Used by GitHub Actions through OpenID Connect. **Contributor** on the resource group only. Setup script. |
| Federated credential | `github-test` on the deploy identity | Subject `repo:georgeahanna-ux@302303945/hdit-pipeline@1430410857:environment:test`. GitHub sends owner and repo IDs in the subject, so the subject must include them. |
| App identity | `id-hdit-pipeline-func-test-aue` | The Function App runs as this. Setup script, with the roles below. |
| Function App | `func-hdit-pipeline-test-aue` | Flex Consumption, Node 22, Linux. Bicep. |
| Plan | `asp-hdit-pipeline-test-aue` | Flex Consumption (FC1). Bicep. |
| Static Web App | `stapp-hdit-pipeline-test-aue` | Free tier, East Asia (not offered in Australia; served from the global edge). Bicep. |
| Key Vault | `kv-hdit-pipeline-test` | RBAC mode. Holds the team password, admin list and Autotask credentials. Bicep. |
| Storage | `sthditpipelinetestaue` | Shared-key access off. Functions host, deployment packages, table `settings` (Pulse sign-in links). Bicep. |
| Monitoring | `appi-hdit-pipeline-test-aue`, `log-hdit-pipeline-test-aue` | Application Insights on a Log Analytics workspace, 1 GB/day cap. Bicep. |

Everything Bicep creates is tagged `app=pipeline env=test owner=HDIT workload=hdit-pipeline managedBy=bicep`.

### Why two identities

The deploy identity can create and update resources but **can't grant permissions**. HD IT accounts can't hand out privileged roles, and the pipeline shouldn't be able to either. So the app's identity is created up front and given exactly what the Function needs, on the resource group:

| Role | Why |
|---|---|
| Key Vault Secrets Officer | Read secrets; Settings writes credentials, password and admins |
| Storage Blob Data Owner | Functions host and deployment packages |
| Storage Queue Data Contributor | Functions host |
| Storage Table Data Contributor | Pulse sign-in links |
| Monitoring Metrics Publisher | Application Insights |

You also get **Key Vault Secrets Officer** on the resource group so you can manage secrets.

## Step 1 (once): create the resource group and identities

Use the setup script from the Pulse repository (`georgeahanna-ux/hdit-pulse`, `setup/pulse-setup.sh`). In **Azure Cloud Shell** (Bash), signed in with the account you used for Marketing ROI, upload the file (**Manage files → Upload**) and run:

```bash
bash pulse-setup.sh pipeline
```

It creates the resource group, both identities, the GitHub trust for this repository and the role assignments below, and gives you Key Vault Secrets Officer. It's safe to run again. The last line it prints is `PIPELINE_DEPLOY_CLIENT_ID=…`.

## Step 2 (once): point GitHub at the deploy identity

`PIPELINE_DEPLOY_CLIENT_ID` is the deploy identity's client ID. It isn't a secret. Either:

- paste it to Claude, who commits it as the workflow default, **or**
- in GitHub: the repo → **Settings → Secrets and variables → Actions → Variables → New repository variable**, name `AZURE_CLIENT_ID`, value the ID. Then **Actions → Deploy to test → Run workflow**.

Until it's set, every push still builds and tests the app, and the run shows a "Not deployed" warning instead of failing.

## How a deployment runs

Every push to `main` (or **Run workflow** on the Actions tab) runs `.github/workflows/deploy-test.yml`:

1. Installs and tests the backend.
2. Signs in to Azure as the deploy identity (no stored secrets).
3. Deploys `infra/main.bicep`. This is idempotent; unchanged resources are left alone.
4. Deploys the backend to the Function App.
5. Builds the frontend with the API address filled in, and deploys it to the Static Web App.
6. Calls `/api/health` and checks CORS. The run summary shows the app's address.

## Step 3 (after the first deployment): add the secrets

You need Autotask API credentials for Pipeline. Either reuse the production Pipeline API user (its credentials are in the production Key Vault), or create a **dedicated Autotask API user** for test: Admin → Resources/Users → New → **API User**.

- It needs to **view** Opportunities, Companies, Contacts, Resources, Quotes and Tickets; **edit** Opportunities and Tickets (stage, close date, probability, linking tickets); and **add** company notes. Allow impersonation for company notes so notes are recorded as the salesperson.
- Note its username, secret and tracking identifier (integration code).

Then in Cloud Shell (Bash), paste this first. It only **defines** a command; pasting a block of `read` prompts directly makes the shell feed the following lines into the prompts:

```bash
seed_pipeline() {
  local KV="kv-hdit-pipeline-test" U S C P P2
  read -r -p    "Autotask API username: " U
  read -r -s -p "Autotask API secret: " S; echo
  read -r -s -p "Autotask API integration code: " C; echo
  read -r -s -p "Team password for the app (10+ characters): " P; echo
  read -r -s -p "Type the team password again: " P2; echo
  if [ -z "$U" ] || [ -z "$S" ] || [ -z "$C" ]; then echo "A value was empty. Nothing saved."; return 1; fi
  if [ "$P" != "$P2" ] || [ ${#P} -lt 10 ]; then echo "Passwords don't match or are under 10 characters. Nothing saved."; return 1; fi
  az keyvault secret set --vault-name $KV -n autotask-api-username         --value "$U" -o none && echo "OK username"
  az keyvault secret set --vault-name $KV -n autotask-api-secret           --value "$S" -o none && echo "OK secret"
  az keyvault secret set --vault-name $KV -n autotask-api-integration-code --value "$C" -o none && echo "OK integration code"
  az keyvault secret set --vault-name $KV -n app-password                  --value "$P" -o none && echo "OK team password"
  az keyvault secret set --vault-name $KV -n autotask-base-url --value "https://webservices29.autotask.net/ATServicesRest/" -o none && echo "OK base url"
}
```

Then type `seed_pipeline`, press Enter, and answer the prompts.

Then make yourself an administrator:

1. Open the app, sign in with the team password and pick your name.
2. Open your menu (your initials, top right). It shows **Autotask resource #NNN**.
3. Run, replacing the number:
   ```bash
   az keyvault secret set --vault-name kv-hdit-pipeline-test -n admin-resource-ids --value "NNN" -o none
   ```
4. Sign out and back in. **Settings** appears in your menu.

With Pulse sign-in, administrators come from the **Pulse - Pipeline Admins** group instead, so this step is only needed for the team password.

## Step 4: check the board

Sign in and confirm the stages and opportunities load, a drag between stages writes back to Autotask, and a note appears in Autotask under your name.

## Troubleshooting

| Symptom | Check |
|---|---|
| A run shows "Not deployed" | `AZURE_CLIENT_ID` isn't set yet (step 2). |
| A deploy fails at "Sign in to Azure" with `AADSTS70021` | The federated credential's subject doesn't match. It must be exactly the subject in step 1, and the job uses `environment: test`. |
| A deploy fails at "Infrastructure - Bicep" with an authorisation error | The deploy identity's Contributor role is missing on `rg-hdit-pipeline-test-aue`. |
| "The team password hasn't been set yet" | `app-password` is missing from Key Vault. |
| "The Autotask connection isn't set up yet" | One of the four `autotask-*` secrets is missing. |
| "Autotask rejected the API credentials" | Username, secret or integration code is wrong, or the base URL is the web address (`ww29`) instead of the REST address (`webservices29`). |
| The site loads but every action fails with "Failed to fetch" | CORS: the Static Web App address must be in the Function App's allowed origins. Bicep sets it; re-run the workflow. |
| Anything else | Application Insights → Failures, or `/api/health`. |

## HD IT Pulse sign-in

The app can run inside HD IT Pulse, which signs people in with Microsoft 365 (Entra ID). See `docs/IDENTITY-AND-ACCESS.md` in `georgeahanna-ux/hdit-pulse` for the design and the one-off setup.

| Where | Setting | Value |
|---|---|---|
| `infra/test.bicepparam` | `entraClientId` | The HD IT Pulse app registration's client id. Empty = Pulse sign-in off. |
| `infra/test.bicepparam` | `teamSignIn` | `on` keeps the team password working; `off` = Pulse only. |
| `.github/workflows/deploy-test.yml` | `PULSE_ORIGIN` | Pulse's address, e.g. `https://<name>.azurestaticapps.net`. Lets Pulse frame the app. |

With Pulse sign-in, roles come from Entra groups, and the Key Vault `admin-resource-ids` list only applies to team-password sign-ins.
