using './main.bicep'

param app = 'pipeline'
param env = 'test'

// HD IT Pulse sign-in (Entra ID, HD IT Testing Tenancy). Pulse sign-in stays off while entraClientId is empty.
param entraTenantId = '0b1e12e5-f6cd-4ae7-a9ff-4562637a0c44'
param entraClientId = '1b247714-1319-4edf-9115-de80b3360561'
param teamSignIn = 'on'
