targetScope = 'resourceGroup'

@description('Azure region for regional resources. Choose a region supported by Front Door Premium Private Link.')
param location string = resourceGroup().location

@description('Short environment name used in resource names.')
@allowed(['dev', 'staging', 'prod'])
param environment string = 'prod'

@description('Microsoft Entra application registration client ID for App Service Authentication.')
param entraWebClientId string

@description('Object ID of an Entra group that will administer PostgreSQL.')
param postgresAdminObjectId string

@description('Display name of the PostgreSQL Entra administrator group.')
param postgresAdminName string

@description('Bootstrap-only PostgreSQL administrator password. Password authentication is disabled after creation; applications use Entra tokens.')
@secure()
param postgresBootstrapPassword string

@description('Email address for operational alerts.')
param alertEmail string

@description('Container image tag to deploy after it has been pushed to the provisioned ACR.')
param imageTag string = 'latest'

@description('Create App Service, Container Apps, Front Door, and workload monitoring. Keep false for the foundation deployment; set true after publishing images to ACR.')
param deployWorkloads bool = false

var suffix = uniqueString(resourceGroup().id)
var baseName = 'll${environment}${suffix}'
var webName = take('${baseName}-web', 60)
var webPlanName = take('${baseName}-plan', 40)
var workerName = take('${baseName}-worker', 32)
var envName = take('${baseName}-cae', 32)
var registryName = replace('ll${environment}${suffix}', '-', '')
var storageName = replace('ll${environment}${suffix}st', '-', '')
var postgresName = take('${baseName}-pg', 63)
var vaultName = take('ll-${environment}-${suffix}-kv', 24)
var frontDoorName = take('${baseName}-afd', 50)
var endpointName = take('${baseName}-edge', 50)
var workspaceName = take('${baseName}-logs', 63)
var webIdentityName = take('${baseName}-web-id', 64)
var workerIdentityName = take('${baseName}-worker-id', 64)
var migrationIdentityName = take('${baseName}-migration-id', 64)
var postgresDnsName = 'private.postgres.database.azure.com'
var storageDnsName = 'privatelink.blob.${az.environment().suffixes.storage}'
var vaultDnsName = 'privatelink.vaultcore.azure.net'
var webImage = '${registry.properties.loginServer}/ledgerline/web:${imageTag}'
var workerImage = '${registry.properties.loginServer}/ledgerline/worker:${imageTag}'
var postgresTokenUserWeb = webIdentityName
var postgresTokenUserWorker = workerIdentityName
var easyAuthSecretName = 'entra-web-client-secret'
var keyVaultReference = '@Microsoft.KeyVault(VaultName=${vault.name};SecretName=${easyAuthSecretName})'

resource logWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    retentionInDays: 90
    sku: { name: 'PerGB2018' }
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: take('${baseName}-vnet', 64)
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.40.1.0/24'
          delegations: [{ name: 'postgres-flexible', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
        }
      }
      {
        name: 'container-apps'
        properties: {
          addressPrefix: '10.40.2.0/23'
          delegations: [{ name: 'container-apps', properties: { serviceName: 'Microsoft.App/environments' } }]
        }
      }
      {
        name: 'app-service-integration'
        properties: {
          addressPrefix: '10.40.4.0/26'
          delegations: [{ name: 'app-service', properties: { serviceName: 'Microsoft.Web/serverFarms' } }]
        }
      }
      {
        name: 'private-endpoints'
        properties: {
          addressPrefix: '10.40.5.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'postgres'
}
resource containerSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'container-apps'
}
resource appServiceSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'app-service-integration'
}
resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'private-endpoints'
}

resource postgresDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: postgresDnsName
  location: 'global'
}
resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: postgresDns
  name: take('${baseName}-pg-link', 80)
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: postgresName
  location: location
  sku: { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' }
  properties: {
    administratorLogin: 'ledgerlinebootstrap'
    administratorLoginPassword: postgresBootstrapPassword
    version: '16'
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenant().tenantId
    }
    network: {
      delegatedSubnetResourceId: postgresSubnet.id
      privateDnsZoneArmResourceId: postgresDns.id
      publicNetworkAccess: 'Disabled'
    }
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'ZoneRedundant' }
  }
  dependsOn: [postgresDnsLink]
}

resource postgresAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: postgres
  name: postgresAdminObjectId
  properties: {
    principalName: postgresAdminName
    principalType: 'Group'
    tenantId: tenant().tenantId
  }
}

resource ledgerlineDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: 'ledgerline'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None', ipRules: [], virtualNetworkRules: [] }
  }
}
resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource csvContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'ledgerline-csv'
  properties: { publicAccess: 'None' }
}

resource storageDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: storageDnsName
  location: 'global'
}
resource storageDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: storageDns
  name: take('${baseName}-blob-link', 80)
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource storagePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: take('${baseName}-blob-pe', 64)
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [{
      name: take('${baseName}-blob-connection', 80)
      properties: { privateLinkServiceId: storage.id, groupIds: ['blob'], requestMessage: 'Ledgerline private Blob access' }
    }]
  }
}
resource storagePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: storagePrivateEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'blob', properties: { privateDnsZoneId: storageDns.id } }] }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: vaultName
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Disabled'
    networkAcls: { defaultAction: 'Deny', bypass: 'None', ipRules: [], virtualNetworkRules: [] }
  }
}
resource vaultDns 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: vaultDnsName
  location: 'global'
}
resource vaultDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: vaultDns
  name: take('${baseName}-vault-link', 80)
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
resource vaultPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: take('${baseName}-vault-pe', 64)
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [{
      name: take('${baseName}-vault-connection', 80)
      properties: { privateLinkServiceId: vault.id, groupIds: ['vault'], requestMessage: 'Ledgerline Key Vault private access' }
    }]
  }
}
resource vaultPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: vaultPrivateEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'vault', properties: { privateDnsZoneId: vaultDns.id } }] }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false, publicNetworkAccess: 'Enabled' }
}

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: webIdentityName
  location: location
}
resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: workerIdentityName
  location: location
}
resource migrationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: migrationIdentityName
  location: location
}

var storageBlobDataContributorRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var keyVaultSecretsUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')

resource webStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, webIdentity.id, storageBlobDataContributorRole)
  scope: storage
  properties: { roleDefinitionId: storageBlobDataContributorRole, principalId: webIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource webRegistryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, webIdentity.id, acrPullRole)
  scope: registry
  properties: { roleDefinitionId: acrPullRole, principalId: webIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource workerRegistryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, workerIdentity.id, acrPullRole)
  scope: registry
  properties: { roleDefinitionId: acrPullRole, principalId: workerIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource migrationRegistryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, migrationIdentity.id, acrPullRole)
  scope: registry
  properties: { roleDefinitionId: acrPullRole, principalId: migrationIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}
resource webVaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, webIdentity.id, keyVaultSecretsUserRole)
  scope: vault
  properties: { roleDefinitionId: keyVaultSecretsUserRole, principalId: webIdentity.properties.principalId, principalType: 'ServicePrincipal' }
}

resource appServicePlan 'Microsoft.Web/serverfarms@2024-04-01' = if (deployWorkloads) {
  name: webPlanName
  location: location
  kind: 'linux'
  sku: { name: 'P1v3', tier: 'PremiumV3', capacity: 1 }
  properties: { reserved: true }
}

resource web 'Microsoft.Web/sites@2024-04-01' = if (deployWorkloads) {
  name: webName
  location: location
  kind: 'app,linux,container'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${webIdentity.id}': {} }
  }
  properties: {
    serverFarmId: appServicePlan!.id
    httpsOnly: true
    publicNetworkAccess: 'Disabled'
    virtualNetworkSubnetId: appServiceSubnet.id
    vnetRouteAllEnabled: true
    keyVaultReferenceIdentity: webIdentity.id
    siteConfig: {
      linuxFxVersion: 'DOCKER|${webImage}'
      acrUseManagedIdentityCreds: true
      acrUserManagedIdentityID: webIdentity.properties.clientId
      alwaysOn: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '3000' }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
        { name: 'AZURE_CLIENT_ID', value: webIdentity.properties.clientId }
        { name: 'AZURE_POSTGRES_HOST', value: postgres.properties.fullyQualifiedDomainName }
        { name: 'AZURE_POSTGRES_USER', value: postgresTokenUserWeb }
        { name: 'AZURE_POSTGRES_DATABASE', value: 'ledgerline' }
        { name: 'AZURE_STORAGE_ACCOUNT_URL', value: 'https://${storage.name}.blob.${az.environment().suffixes.storage}' }
        { name: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET', value: keyVaultReference }
        { name: 'NODE_ENV', value: 'production' }
      ]
    }
  }
  dependsOn: [webRegistryRole, webVaultRole, webStorageRole, ledgerlineDb]
}

resource webAuth 'Microsoft.Web/sites/config@2022-09-01' = if (deployWorkloads) {
  parent: web
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureActiveDirectory'
      excludedPaths: ['/api/health']
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: entraWebClientId
          clientSecretSettingName: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          openIdIssuer: '${az.environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
        }
        validation: { allowedAudiences: [entraWebClientId] }
      }
    }
    httpSettings: {
      requireHttps: true
      forwardProxy: { convention: 'Standard' }
    }
    login: { tokenStore: { enabled: false } }
  }
}

resource containerEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = if (deployWorkloads) {
  name: envName
  location: location
  properties: {
    vnetConfiguration: { infrastructureSubnetId: containerSubnet.id, internal: true }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logWorkspace.properties.customerId
        sharedKey: logWorkspace.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
  dependsOn: [containerSubnet]
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = if (deployWorkloads) {
  name: workerName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${workerIdentity.id}': {} }
  }
  properties: {
    managedEnvironmentId: containerEnvironment!.id
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registry.properties.loginServer, identity: workerIdentity.id }]
    }
    template: {
      containers: [{
        name: 'workflow-worker'
        image: workerImage
        resources: {
          cpu: json('0.5')
          memory: '1Gi'
        }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'AZURE_CLIENT_ID', value: workerIdentity.properties.clientId }
          { name: 'AZURE_POSTGRES_HOST', value: postgres.properties.fullyQualifiedDomainName }
          { name: 'AZURE_POSTGRES_USER', value: postgresTokenUserWorker }
          { name: 'AZURE_POSTGRES_DATABASE', value: 'ledgerline' }
        ]
      }]
      scale: {
        minReplicas: 1
        maxReplicas: 10
        rules: [{ name: 'cpu', custom: { type: 'cpu', metadata: { type: 'Utilization', value: '70' } } }]
      }
    }
  }
  dependsOn: [workerRegistryRole, postgresAdmin, ledgerlineDb]
}

resource migrateJob 'Microsoft.App/jobs@2024-03-01' = if (deployWorkloads) {
  name: take('${baseName}-migrate', 32)
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${migrationIdentity.id}': {} }
  }
  properties: {
    environmentId: containerEnvironment!.id
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registry.properties.loginServer, identity: migrationIdentity.id }]
    }
    template: {
      containers: [{
        name: 'migrate'
        image: webImage
        command: ['node', 'scripts/migrate.mjs']
        resources: { cpu: 1, memory: '2Gi' }
        env: [
          { name: 'NODE_ENV', value: 'production' }
          { name: 'AZURE_CLIENT_ID', value: migrationIdentity.properties.clientId }
          { name: 'AZURE_POSTGRES_HOST', value: postgres.properties.fullyQualifiedDomainName }
          { name: 'AZURE_POSTGRES_USER', value: migrationIdentityName }
          { name: 'AZURE_POSTGRES_DATABASE', value: 'ledgerline' }
        ]
      }]
    }
  }
  dependsOn: [migrationRegistryRole, postgresAdmin, ledgerlineDb]
}

resource autoscale 'Microsoft.Insights/autoscaleSettings@2022-10-01' = if (deployWorkloads) {
  name: take('${baseName}-web-scale', 80)
  location: location
  properties: {
    enabled: true
    targetResourceUri: appServicePlan!.id
    profiles: [{
      name: 'CPU scaling'
      capacity: { minimum: '1', maximum: '5', default: '1' }
      rules: [
        {
          metricTrigger: { metricName: 'CpuPercentage', metricResourceUri: appServicePlan!.id, timeGrain: 'PT1M', statistic: 'Average', timeWindow: 'PT10M', timeAggregation: 'Average', operator: 'GreaterThan', threshold: 70 }
          scaleAction: { direction: 'Increase', type: 'ChangeCount', value: '1', cooldown: 'PT5M' }
        }
        {
          metricTrigger: { metricName: 'CpuPercentage', metricResourceUri: appServicePlan!.id, timeGrain: 'PT1M', statistic: 'Average', timeWindow: 'PT10M', timeAggregation: 'Average', operator: 'LessThan', threshold: 30 }
          scaleAction: { direction: 'Decrease', type: 'ChangeCount', value: '1', cooldown: 'PT10M' }
        }
      ]
    }]
  }
}

resource frontDoor 'Microsoft.Cdn/profiles@2021-06-01' = if (deployWorkloads) {
  name: frontDoorName
  location: 'global'
  sku: { name: 'Premium_AzureFrontDoor' }
}
resource frontDoorEndpoint 'Microsoft.Cdn/profiles/afdEndpoints@2021-06-01' = if (deployWorkloads) {
  parent: frontDoor
  name: endpointName
  location: 'global'
  properties: { enabledState: 'Enabled' }
}
resource originGroup 'Microsoft.Cdn/profiles/originGroups@2021-06-01' = if (deployWorkloads) {
  parent: frontDoor
  name: 'ledgerline-web'
  properties: {
    loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3, additionalLatencyInMilliseconds: 50 }
    healthProbeSettings: { probePath: '/api/health', probeRequestType: 'GET', probeProtocol: 'Https', probeIntervalInSeconds: 100 }
  }
}
resource webOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2021-06-01' = if (deployWorkloads) {
  parent: originGroup
  name: 'web'
  properties: {
    hostName: web!.properties.defaultHostName
    originHostHeader: web!.properties.defaultHostName
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
    sharedPrivateLinkResource: {
      privateLink: { id: web!.id }
      groupId: 'sites'
      privateLinkLocation: location
      requestMessage: 'Approve Front Door private origin for Ledgerline web.'
    }
  }
}
resource frontDoorRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2021-06-01' = if (deployWorkloads) {
  parent: frontDoorEndpoint
  name: 'ledgerline'
  properties: {
    originGroup: { id: originGroup!.id }
    supportedProtocols: ['Http', 'Https']
    patternsToMatch: ['/*']
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Enabled'
    enabledState: 'Enabled'
  }
}

resource waf 'Microsoft.Network/frontdoorwebapplicationfirewallpolicies@2022-05-01' = if (deployWorkloads) {
  name: take('${baseName}-waf', 128)
  location: 'global'
  sku: { name: 'Premium_AzureFrontDoor' }
  properties: {
    policySettings: { enabledState: 'Enabled', mode: 'Prevention', requestBodyCheck: 'Enabled' }
    managedRules: { managedRuleSets: [{ ruleSetType: 'Microsoft_DefaultRuleSet', ruleSetVersion: '2.1' }] }
    customRules: {
      rules: [{
        name: 'rate-limit'
        priority: 1
        enabledState: 'Enabled'
        ruleType: 'RateLimitRule'
        rateLimitDurationInMinutes: 1
        rateLimitThreshold: 300
        action: 'Block'
        matchConditions: [{ matchVariable: 'RemoteAddr', operator: 'IPMatch', matchValue: ['0.0.0.0/0', '::/0'] }]
      }]
    }
  }
}
resource frontDoorSecurity 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = if (deployWorkloads) {
  parent: frontDoor
  name: 'waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: waf!.id }
      associations: [{
        domains: [{ id: frontDoorEndpoint!.id }]
        patternsToMatch: ['/*']
      }]
    }
  }
}

resource alertGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: take('${baseName}-alerts', 80)
  location: 'global'
  properties: {
    groupShortName: 'LedgerOps'
    enabled: true
    emailReceivers: [{ name: 'operations', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}

resource web5xxAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (deployWorkloads) {
  name: take('${baseName}-web-5xx', 80)
  location: 'global'
  properties: {
    description: 'Alert when Ledgerline web returns repeated server errors.'
    severity: 1
    enabled: true
    scopes: [web!.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{ criterionType: 'StaticThresholdCriterion', name: 'HTTP 5xx', metricName: 'Http5xx', metricNamespace: 'Microsoft.Web/sites', operator: 'GreaterThan', threshold: 10, timeAggregation: 'Total', dimensions: [] }]
    }
    actions: [{ actionGroupId: alertGroup.id }]
  }
}
resource postgresCpuAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: take('${baseName}-pg-cpu', 80)
  location: 'global'
  properties: {
    description: 'Alert when PostgreSQL CPU remains above 80 percent.'
    severity: 2
    enabled: true
    scopes: [postgres.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [{ criterionType: 'StaticThresholdCriterion', name: 'CPU percent', metricName: 'cpu_percent', metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers', operator: 'GreaterThan', threshold: 80, timeAggregation: 'Average', dimensions: [] }]
    }
    actions: [{ actionGroupId: alertGroup.id }]
  }
}

resource webDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (deployWorkloads) {
  scope: web!
  name: 'send-to-log-analytics'
  properties: {
    workspaceId: logWorkspace.id
    logs: [
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}
resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: postgres
  name: 'send-to-log-analytics'
  properties: {
    workspaceId: logWorkspace.id
    logs: [{ category: 'PostgreSQLLogs', enabled: true }]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}
resource frontDoorDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (deployWorkloads) {
  scope: frontDoor!
  name: 'send-to-log-analytics'
  properties: {
    workspaceId: logWorkspace.id
    logs: [
      { category: 'FrontDoorAccessLog', enabled: true }
      { category: 'FrontDoorHealthProbeLog', enabled: true }
    ]
    metrics: [{ category: 'AllMetrics', enabled: true }]
  }
}

output webAppName string = deployWorkloads ? web!.name : ''
output frontDoorHostName string = deployWorkloads ? frontDoorEndpoint!.properties.hostName : ''
output postgresHost string = postgres.properties.fullyQualifiedDomainName
output storageAccountName string = storage.name
output containerAppsEnvironmentName string = deployWorkloads ? containerEnvironment!.name : ''
output registryLoginServer string = registry.properties.loginServer
output postgresAdminIdentityName string = postgresAdminName
output applicationIdentityNames array = [webIdentity.name, workerIdentity.name, migrationIdentity.name]
