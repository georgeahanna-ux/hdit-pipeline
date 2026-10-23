// =============================================================================
// Pipeline (pipeline) — Azure infrastructure
//
// Deployed by GitHub Actions into an EXISTING resource group using the deploy
// identity (id-hdit-pipeline-deploy-<env>-aue, Contributor on the resource group).
//
// Deliberately contains NO role assignments: the deploy identity cannot grant
// roles. The Function App runs as a pre-created user-assigned identity
// (id-hdit-pipeline-func-<env>-aue) that an administrator has already given:
//   Key Vault Secrets Officer, Storage Blob Data Owner, Storage Queue Data
//   Contributor, Storage Table Data Contributor, Monitoring Metrics Publisher
// on the resource group. See docs/AZURE-SETUP.md.
//
// Naming follows HD IT's CAF convention: <type>-hdit-<app>-<env>-<region>.
// =============================================================================

targetScope = 'resourceGroup'

@description('Short app code (<= 8 chars).')
@maxLength(8)
param app string = 'pipeline'

@description('Environment: dev, test or prod.')
@allowed([ 'dev', 'test', 'prod' ])
param env string = 'test'

@description('Region for everything except the Static Web App.')
param location string = 'australiaeast'

@description('Static Web Apps are not offered in Australia; East Asia is the nearest. Content is still served from the global edge.')
param swaLocation string = 'eastasia'

@description('HD IT Pulse sign-in: the Entra tenant that issues tokens. Empty = Pulse sign-in off.')
param entraTenantId string = ''

@description('HD IT Pulse sign-in: application (client) id of the HD IT Pulse app registration. Empty = Pulse sign-in off.')
param entraClientId string = ''

@description('Keep the team password working alongside Pulse sign-in (on) or turn it off (off).')
@allowed([ 'on', 'off' ])
param teamSignIn string = 'on'

@description('Tags applied to every resource.')
param tags object = {
  app: app
  env: env
  owner: 'HDIT'
  workload: 'hdit-pipeline'
  managedBy: 'bicep'
}

var regionCode = 'aue'
var base = 'hdit-${app}-${env}'
var names = {
  log: 'log-${base}-${regionCode}'
  appi: 'appi-${base}-${regionCode}'
  storage: toLower('sthdit${app}${env}${regionCode}')
  kv: 'kv-${base}'
  plan: 'asp-${base}-${regionCode}'
  func: 'func-${base}-${regionCode}'
  swa: 'stapp-${base}-${regionCode}'
  funcIdentity: 'id-hdit-${app}-func-${env}-${regionCode}'   // pre-created: id-hdit-pipeline-func-test-aue
}
var deploymentContainer = 'deployments'

// ---------------------------------------------------------------------------
// Identity the Function App runs as (created and granted roles beforehand)
// ---------------------------------------------------------------------------
resource funcIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: names.funcIdentity
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------
resource log 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: names.log
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: 1 }
  }
}

resource appi 'Microsoft.Insights/components@2020-02-02' = {
  name: names.appi
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: log.id
    IngestionMode: 'LogAnalytics'
  }
}

// ---------------------------------------------------------------------------
// Storage: Functions host, deployment packages, and the app's tables.
// Shared-key access is off; everything uses Entra ID (managed identity).
// ---------------------------------------------------------------------------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: names.storage
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource deployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deploymentContainer
  properties: { publicAccess: 'None' }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

// settings: HD IT Pulse sign-in links (who is which Autotask resource) and future app settings
resource tables 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = [for t in [ 'settings' ]: {
  parent: tableService
  name: t
}]

// ---------------------------------------------------------------------------
// Key Vault (RBAC). Secrets are seeded by an administrator, never by the pipeline.
// ---------------------------------------------------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: names.kv
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

// ---------------------------------------------------------------------------
// Frontend: Static Web App (Free)
// ---------------------------------------------------------------------------
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: names.swa
  location: swaLocation
  tags: tags
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    stagingEnvironmentPolicy: 'Disabled'
    allowConfigFileUpdates: true
  }
}

// ---------------------------------------------------------------------------
// Backend: Function App on Flex Consumption, Node 22, Linux
// ---------------------------------------------------------------------------
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: names.plan
  location: location
  tags: tags
  kind: 'functionapp'
  sku: { tier: 'FlexConsumption', name: 'FC1' }
  properties: { reserved: true }
}

resource func 'Microsoft.Web/sites@2024-04-01' = {
  name: names.func
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${funcIdentity.id}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    keyVaultReferenceIdentity: funcIdentity.id
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      cors: {
        allowedOrigins: [ 'https://${swa.properties.defaultHostname}' ]
        supportCredentials: false
      }
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AzureWebJobsStorage__clientId', value: funcIdentity.properties.clientId }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appi.properties.ConnectionString }
        { name: 'AZURE_CLIENT_ID', value: funcIdentity.properties.clientId }
        { name: 'KEY_VAULT_URI', value: kv.properties.vaultUri }
        { name: 'TABLES_ENDPOINT', value: storage.properties.primaryEndpoints.table }
        { name: 'APP_SESSION_SALT', value: '${app}-session-v1' }
        { name: 'APP_ENVIRONMENT', value: env }
        { name: 'ENTRA_TENANT_ID', value: entraTenantId }
        { name: 'ENTRA_CLIENT_ID', value: entraClientId }
        { name: 'ENTRA_ROLE_PREFIX', value: 'Pipeline' }
        { name: 'PULSE_APP_NAME', value: 'Pipeline' }
        { name: 'LEGACY_PASSWORD_LOGIN', value: teamSignIn }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainer}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: funcIdentity.id
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 40
        instanceMemoryMB: 2048
      }
      runtime: { name: 'node', version: '22' }
    }
  }
  dependsOn: [ deployContainer ]
}

// No FTP publishing
resource ftpOff 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: func
  name: 'ftp'
  properties: { allow: false }
}

// ---------------------------------------------------------------------------
output functionAppName string = func.name
output functionHostname string = func.properties.defaultHostName
output staticWebAppName string = swa.name
output staticWebAppHostname string = swa.properties.defaultHostname
output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
output storageAccountName string = storage.name
