"use strict";
/**
 * One Azure credential for Key Vault and Table Storage.
 * In Azure the Function runs as the user-assigned identity whose client id is in
 * AZURE_CLIENT_ID. Locally, DefaultAzureCredential picks up your `az login`.
 */
const { ManagedIdentityCredential, DefaultAzureCredential } = require("@azure/identity");

const credential = process.env.WEBSITE_SITE_NAME && process.env.AZURE_CLIENT_ID
  ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
  : new DefaultAzureCredential();

module.exports = { credential };
