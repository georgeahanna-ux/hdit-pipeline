# Pipeline — Setup Guide (Plain-English Version)

This guide walks you through getting the app online, one small step at a time. You don't need to be a developer, and **you won't have to install anything** — every technical step is done in a normal browser tab. That makes it safe for a locked-down work laptop.

Set aside about **an hour**. Take it slowly — there's no harm in stopping and coming back.

---

## First, the simple picture

The app is made of **two parts**:

1. **The webpage** (`index.html`) — what your salespeople see and click.
2. **The engine** (the `backend` folder) — the part that quietly talks to Autotask behind the scenes.

These two parts live in **two different places** in Azure, and they talk to each other over the internet. Most of this guide is just creating those places and telling each part where the other one lives.

Think of it like a shop: the **webpage** is the shopfront customers walk into, and the **engine** is the stockroom out the back. We set up both, then connect a door between them.

You'll also create two small helpers:

- A **secure vault** to hold your Autotask password safely (so it's never sitting in the webpage).
- A **filing cabinet** for keeping people signed in.

---

## Keep a notepad open

Throughout this guide you'll copy down a handful of values. Open a blank note and keep these handy — you'll paste them in later:

```
WEBSITE ADDRESS:        ____________________________
ENGINE ADDRESS:         ____________________________
MICROSOFT CLIENT ID:    ____________________________
MICROSOFT TENANT ID:    ____________________________
AUTOTASK USERNAME:      ____________________________
AUTOTASK SECRET:        ____________________________
AUTOTASK CODE:          ____________________________
AUTOTASK WEB ADDRESS:   ____________________________
STORAGE CONNECTION:     ____________________________
```

Don't worry about what they all mean yet — the steps tell you when to grab each one.

---

## Before you start

You'll need:

- An **Azure account** that lets you create things. If your company already uses Microsoft 365, you likely have Azure available — ask whoever manages your Microsoft account if you're unsure.
- An **Autotask administrator** (possibly you) who can create an "API user." This is a one-time, 5-minute job inside Autotask.
- The downloaded project folder (`autotask-kanban`) with `index.html` and the `backend` folder inside it.
- A modern browser — **Microsoft Edge or Google Chrome** are best, because the browser-based code editor we use works most smoothly in them.

Everything we create in Azure costs **almost nothing** at your size — typically a few dollars a month, and some of it is free.

---

# Part 1 — Get your Autotask keys

*(Done inside Autotask. Easy. Ask your Autotask admin if you don't have admin rights.)*

The engine needs a "key" to talk to Autotask. We create a special login just for that.

1. In Autotask, go to the menu: **Admin → Resources (Users)**.
2. Click the small arrow next to the **New** button and choose **New API User**.
3. Fill in the basic details. When it shows you a **Username (Key)** and a **Password (Secret)**, copy **both** into your notepad now — *the secret is only shown once.*
   - Notepad: **AUTOTASK USERNAME** and **AUTOTASK SECRET**
4. On the same screen, find the **API Tracking Identifier** (also called integration code) and copy it.
   - Notepad: **AUTOTASK CODE**
5. Ask Autotask (or check the API Zones help page) for your **API web address**. It looks like `https://webservices12.autotask.net/atservicesrest`. Copy it.
   - Notepad: **AUTOTASK WEB ADDRESS**

**One important tick-box:** on this API user's permissions, turn on **"Allow impersonation"** for **Opportunities** and **Company Notes**. This is what makes changes show up under each *real* salesperson's name in Autotask, instead of a generic robot account. If you're not sure how, your Autotask admin will know — just tell them "enable impersonation for Opportunities and Company Notes on the new API user."

---

# Part 2 — Create the home for your webpage

*(Done in the Azure website. Easy.)*

The webpage needs an address on the internet. We'll create a free "Static Web App" to give it one. We do this **first**, because the next step needs this address.

1. Go to **portal.azure.com** and sign in.
2. In the search bar at the top, type **Static Web Apps** and click it.
3. Click **Create**.
4. Fill in the basics:
   - **Subscription / Resource group:** pick your subscription; for resource group click **Create new** and call it something like `pipeline`.
   - **Name:** something like `pipeline-board`.
   - **Plan type:** choose **Free**.
   - **Deployment:** choose **Other** (this lets us publish manually later — simplest for now).
5. Click **Review + create**, then **Create**. Wait for it to finish, then click **Go to resource**.
6. On the resource page you'll see a **URL** like `https://nice-rock-0a1b2c3.azurestaticapps.net`. Copy it.
   - Notepad: **WEBSITE ADDRESS**

That's your shopfront's address. We'll put the actual webpage there near the end.

---

# Part 3 — Set up "Sign in with Microsoft"

*(Done in the Azure website. A bit fiddly, but just clicking. Take your time.)*

Your team will sign in with their normal Microsoft work accounts. We register the app with Microsoft so it's allowed to do that.

1. In the Azure search bar, type **Microsoft Entra ID** and open it.
2. In the left menu, click **App registrations**, then **New registration**.
3. Set:
   - **Name:** `Pipeline Kanban`
   - **Supported account types:** "Accounts in this organizational directory only."
   - **Redirect URI:** change the dropdown to **Single-page application (SPA)**, and in the box paste your **WEBSITE ADDRESS** from Part 2, making sure it ends with a `/` (for example `https://nice-rock-0a1b2c3.azurestaticapps.net/`).
4. Click **Register**.
5. On the overview page that appears, copy two values into your notepad:
   - **Application (client) ID** → Notepad: **MICROSOFT CLIENT ID**
   - **Directory (tenant) ID** → Notepad: **MICROSOFT TENANT ID**

Now two more small settings on this same app:

6. In the left menu click **Expose an API**.
   - Near the top, next to "Application ID URI," click **Add** and accept the suggested value (it looks like `api://...`). Save.
   - Click **Add a scope**. For the scope name type exactly: `access_as_user`. For who can consent choose **Admins and users**. Fill the display fields with anything sensible (e.g. "Access as user"), and click **Add scope**.
7. In the left menu click **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions** → search for and tick **User.Read** → **Add permissions**. Then click **Grant admin consent** and confirm.

That's the trickiest part done. Well done.

---

# Part 4 — Create the secure vault for your keys

*(Done in the Azure website. Easy.)*

This is where your Autotask secret lives safely.

1. In the Azure search bar, type **Key Vault** and open it. Click **Create**.
2. Use the same **resource group** (`pipeline`) you made earlier. Give it a **name** like `pipeline-vault-yourcompany` (it has to be globally unique, so add your company name). Leave the rest as default.
3. Click **Review + create** → **Create** → **Go to resource**.
4. In the left menu, click **Secrets**, then **Generate/Import**, and add each of the following one at a time. For each: type the **Name** exactly as shown, paste the **Value** from your notepad, click **Create**, then repeat.

   | Name (type exactly) | Value (from your notepad) |
   |---|---|
   | `autotask-api-username` | AUTOTASK USERNAME |
   | `autotask-api-secret` | AUTOTASK SECRET |
   | `autotask-api-integration-code` | AUTOTASK CODE |
   | `autotask-base-url` | AUTOTASK WEB ADDRESS |
   | `admin-emails` | your work email (the people allowed into Settings — separate multiple with commas, no spaces) |

> Later, to change who's an administrator, you just edit the `admin-emails` secret here. No need to redo anything else.

---

# Part 5 — Create the filing cabinet (storage)

*(Done in the Azure website. Easy.)*

This keeps people signed in. It's cheap — a few cents a month.

1. In the Azure search bar, type **Storage accounts** and open it. Click **Create**.
2. Same resource group (`pipeline`). Give it a **name** (lowercase letters and numbers only, e.g. `pipelinestore01`). Leave defaults.
3. Click **Review + create** → **Create** → **Go to resource**.
4. In the left menu, find **Access keys**, click **Show** on key1's **Connection string**, and copy it.
   - Notepad: **STORAGE CONNECTION**

---

# Part 6 — Put the engine online (using VS Code for the Web)

*(This is the most technical step, but it's done **entirely in a browser tab** — nothing to install. If you have an IT person it's a fine one to hand over, but you can absolutely do it yourself.)*

We'll use **VS Code for the Web** — a full version of Microsoft's code editor that runs in a browser. We use the special **Azure edition**, which quietly borrows a small Azure computer (free, up to 4 hours) so it can build and publish your engine, with all the tools already loaded.

**1. Make a small zip of just the engine.**
Open the project's `backend` folder, select everything *inside* it — `host.json`, `package.json`, `local.settings.json`, and the `src` folder — then right-click → **Send to → Compressed (zipped) folder**. Name it `backend.zip`.
*Important:* when you open `backend.zip`, `host.json` must be right there at the top, not inside an extra folder. That's why you select the *contents* and zip those, not the folder itself.

**2. Open VS Code for the Web (Azure edition).**
Go to **`https://vscode.dev/azure`** and sign in with the **same account** you've been using in the Azure portal. The first time, it spends a minute setting up your free workspace. (If it asks to create a small storage area for itself, say yes.)

**3. Open a terminal.**
From the top menu choose **Terminal → New Terminal**. A command strip appears along the bottom — this is where you'll paste a short line in a moment.

**4. Bring your engine in and unpack it.**
Drag your `backend.zip` from your computer straight onto the **Explorer** panel on the left (the file list). Once it appears there, click into the terminal at the bottom, type the line below, and press Enter:

```
unzip backend.zip -d engine
```

(If it replies that `unzip` isn't found, use this instead: `Expand-Archive backend.zip -DestinationPath engine`.)

You now have a folder called **engine** containing the unpacked files. Then open it: top menu **File → Open Folder**, pick the **engine** folder, and allow it if asked.

**5. Publish it to Azure.** Two ways — pick whichever feels comfortable.

*The clicking way (recommended):*
- Click the **Azure** icon in the far-left strip (the "A" logo).
- Find the **Functions** area, click the **Deploy** button (a small cloud with an up-arrow), and choose **Deploy to Function App…** (or press **F1** and type "Deploy to Function App").
- When asked, choose **Create new Function App in Azure…**, give it a globally unique name like `pipeline-engine-yourco`, and pick **Node.js 20** and the **Consumption** (free) plan if it asks.
- Confirm any "are you sure" prompt and, if offered, say **yes** to running the build remotely. It uploads — give it a couple of minutes.

*The typing way (if the button isn't where you expect):*
In the terminal, paste these three lines, changing the names on the first two to match yours (the storage account is the one from Part 5; the engine name must be globally unique):

```
az functionapp create --resource-group pipeline --consumption-plan-location australiaeast --runtime node --runtime-version 20 --functions-version 4 --name pipeline-engine-yourco --storage-account pipelinestore01 --os-type Linux
az functionapp config appsettings set --resource-group pipeline --name pipeline-engine-yourco --settings SCM_DO_BUILD_DURING_DEPLOYMENT=true ENABLE_ORYX_BUILD=true
az functionapp deployment source config-zip --resource-group pipeline --name pipeline-engine-yourco --src backend.zip
```

Either way, when it finishes without a red error message, the engine is live.

**6. Note your engine's address.**
It's `https://` + your engine name + `.azurewebsites.net/api`.
   - Notepad: **ENGINE ADDRESS** = e.g. `https://pipeline-engine-yourco.azurewebsites.net/api`

Now we give the engine its settings, back in the portal:

**7. Add the engine's settings.**
Open **portal.azure.com**, search for **Function App**, and open the one you just made. In the left menu open **Settings → Environment variables** (older portals call this "Configuration"). Click **Add** for each row below:

   | Name | Value |
   |---|---|
   | `KEY_VAULT_URI` | your Key Vault address, e.g. `https://pipeline-vault-yourcompany.vault.azure.net/` (find it on the vault's overview page) |
   | `ENTRA_TENANT_ID` | MICROSOFT TENANT ID |
   | `ENTRA_CLIENT_ID` | MICROSOFT CLIENT ID |
   | `ENTRA_AUDIENCE` | `api://` followed by your MICROSOFT CLIENT ID (e.g. `api://1234-5678-...`) |
   | `TABLES_CONNECTION` | STORAGE CONNECTION |
   | `ALLOWED_ORIGIN` | WEBSITE ADDRESS (no trailing slash, e.g. `https://nice-rock-0a1b2c3.azurestaticapps.net`) |

   Click **Apply / Save** when done.

**8. Let the engine read from the vault.**
Still on the Function App, open **Settings → Identity**, switch **System assigned** to **On**, and **Save**. Then go to your **Key Vault → Access control (IAM) → Add role assignment**, choose the role **Key Vault Secrets Officer**, and assign it to your Function App (search for your engine's name). Save.

That's the engine done.

---

# Part 7 — Finish and publish the webpage (also in VS Code for the Web)

*(Easy. Almost there — and we stay in the same browser tab.)*

1. Back in **VS Code for the Web** (`vscode.dev/azure`), make a clean folder for the site: in the **Explorer** panel on the left, right-click an empty area → **New Folder**, and name it `site`.
2. Drag your `index.html` from your computer **into that `site` folder**, then click it to open it for editing.
3. Near the top you'll see a block that begins `const CONFIG = {`. Change these lines:
   ```
   DEMO_MODE: false,
   API_BASE: "PASTE YOUR ENGINE ADDRESS HERE",
   ```
   A little lower, in the `MSAL` block, paste your two Microsoft values:
   ```
   clientId: "PASTE MICROSOFT CLIENT ID",
   authority: "https://login.microsoftonline.com/PASTE MICROSOFT TENANT ID",
   ```
   Also set `AUTOTASK_UI_BASE` to your Autotask web address (the normal one you log into, e.g. `https://ww1.autotask.net`) so the quote and opportunity links work.
   Press **Ctrl + S** (or **Cmd + S** on Mac) to save.
4. Publish it to the Static Web App from Part 2: click the **Azure** icon in the far-left strip, find the **Static Web Apps** section, right-click your app (e.g. `pipeline-board`) and choose **Deploy to Static Web App…**. When it asks which folder holds your site, choose the **site** folder. If it asks for a "build" or "output" folder, choose the **site** folder again and leave any build command blank. Give it a minute.

   *(Prefer typing? In the terminal run `npm install -g @azure/static-web-apps-cli`, then from inside the `site` folder run `swa deploy` and follow the prompts to pick your Static Web App.)*

---

# Part 8 — First sign-in

1. Open your **WEBSITE ADDRESS** in a browser.
2. Click **Continue with Microsoft** and sign in with your work account.
3. Because your email is in the `admin-emails` vault secret, you'll have the **Administrator** role and can open **Settings** from the menu in the top-right.

If you ever need the built-in starter admin login (only needed before your email is added to the vault):

```
Username:  admin@kanban.local
Password:  Atk-Hwi040kFXooy08XH0zru!9
```

You'll be asked to change that password the first time it's used.

---

## If something doesn't work

The two most common hiccups, both easy to fix:

- **Sign-in pops up an error about the redirect address.** Your **WEBSITE ADDRESS** in Part 3 doesn't exactly match where the page actually loads. Go back to the Entra app registration → **Authentication**, and make sure the SPA redirect URI is exactly your website address ending in `/`.
- **The board loads but stays empty, or you see a "blocked" / CORS message.** The `ALLOWED_ORIGIN` setting on the Function App (Part 6, step 7) must exactly match your website address — this one **without** a trailing slash. Fix it, save, and refresh.

When in doubt: the website address has to be written the same way in two places (the Entra redirect and the engine's `ALLOWED_ORIGIN`). Most first-time problems are a small mismatch there.

---

## Want to just see it first?

You don't have to do any of the above to look at the app. Double-click `index.html` to open it in your browser and click **Explore the demo board** — it runs with sample data so you can see exactly what your team will get before you set up the live version.

---

## A quick map of what you built

| You created | What it does |
|---|---|
| Static Web App | Holds the webpage your team opens |
| Microsoft Entra app registration | Lets people sign in with their work accounts |
| Key Vault | Safely stores your Autotask keys and the admin list |
| Storage account | Keeps people signed in |
| Function App (the engine) | Talks to Autotask and does the real work |

To change administrators later, edit the `admin-emails` secret in Key Vault — nothing else to touch. To update your Autotask keys later, update the matching secrets in Key Vault. Everything else keeps working.
