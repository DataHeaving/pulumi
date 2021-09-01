import * as pulumi from "@pulumi/pulumi";
import * as resources from "@pulumi/azure-native/resources";
import * as authorization from "@pulumi/azure-native/authorization";
import * as msi from "@pulumi/azure-native/managedidentity";
import * as storage from "@pulumi/azure-native/storage";
import * as kv from "@pulumi/azure-native/keyvault";
import * as utils from "@data-heaving/common";
import * as config from "@data-heaving/pulumi-azure-pipeline-config";
import * as types from "./types";

export interface Inputs {
  organization: OrganizationInfo;
  envName: string;
  envSpecificPipelineConfigReader: types.EnvSpecificPipelineConfigReader;
  pulumiPipelineConfig: types.PulumiPipelineConfig<PulumiPipelineAuthInfo>;
  pulumiOpts: {
    provider: pulumi.ProviderResource;
  };
}

export interface OrganizationInfo {
  name: string;
  location: string;
}
export type PulumiPipelineAuthInfo =
  | PulumiPipelineAuthInfoSP
  | PulumiPipelineAuthInfoMSI;

export interface PulumiPipelineAuthInfoSP {
  type: "sp";
  principalId: pulumi.Output<string>;
  clientId: pulumi.Output<string>;
  keyPEM: pulumi.Output<string>;
  certPEM: pulumi.Output<string>;
}

export interface PulumiPipelineAuthInfoMSI {
  type: "msi";
  sharedSARGName: string;
  sharedSAName: string;
  containerPrefixString: string;
}
const createResourcesForSingleEnv = async (inputs: Inputs) => {
  const cicdInfo = await createCICDRG(inputs);
  await createWebsiteRG(inputs, cicdInfo);
  return cicdInfo;
};

const createWebsiteRG = async (
  {
    organization: { name: organization, location },
    envName,
    pulumiOpts,
  }: Inputs,
  {
    principalId,
    principalType,
  }: utils.DePromisify<ReturnType<typeof createCICDRG>>,
) => {
  const resID = `${envName}-site`;
  // RG to hold website resources
  // Will be managed by separate Pulumi pipeline running with given SP principal
  const rg = new resources.ResourceGroup(
    resID,
    {
      resourceGroupName: `${organization}-${envName}-site`,
      location,
    },
    pulumiOpts,
  );

  // Make the Pulumi pipeline able to do anything within RG
  new authorization.RoleAssignment(
    resID,
    {
      principalId,
      scope: rg.id,
      roleDefinitionId: (
        await authorization.getRoleDefinition(
          {
            // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
            roleDefinitionId: "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", // "Owner",
            scope: `/subscriptions/${
              (
                await authorization.getClientConfig(pulumiOpts)
              ).subscriptionId
            }`,
          },
          pulumiOpts,
        )
      ).id,
      principalType,
    },
    pulumiOpts,
  );
};

const createCICDRG = async ({
  organization: { name: organization, location },
  envName,
  envSpecificPipelineConfigReader,
  pulumiPipelineConfig: { auth, pulumiKVInfo },
  pulumiOpts,
}: Inputs) => {
  const resID = `${envName}-cicd`;
  // RG to hold CICD resources
  const resourceGroupName = `${organization}-${envName}-cicd-site`;
  const rg = new resources.ResourceGroup(
    resID,
    {
      resourceGroupName,
      location,
    },
    pulumiOpts,
  );
  let accountName: string;
  let containerName: string;
  let principalId: pulumi.Output<string>;
  let clientId: pulumi.Output<string>;
  let accountKey: pulumi.Output<string> | undefined;
  let principalType: authorization.PrincipalType;
  let msiResource: msi.UserAssignedIdentity | undefined;
  const clientConfig = await authorization.getClientConfig(pulumiOpts);
  const subScope = `/subscriptions/${clientConfig.subscriptionId}`;
  if (auth.type === "msi") {
    // Create MSI to use
    msiResource = new msi.UserAssignedIdentity(
      resID,
      {
        resourceGroupName: rg.name,
        resourceName: `${organization}-${envName}-cicd`,
      },
      pulumiOpts,
    );
    ({ principalId, clientId } = msiResource);

    accountName = auth.sharedSAName;
    containerName = `${auth.containerPrefixString}${envName}`;
    principalType = authorization.PrincipalType.MSI;

    // Create storage container + role assignment to the common SA, since Pulumi backend with MSI auth will not need to use storage-account-wide key
    const container = new storage.BlobContainer(
      resID,
      {
        resourceGroupName: rg.name,
        accountName,
        containerName,
        publicAccess: storage.PublicAccess.None,
      },
      pulumiOpts,
    );

    new authorization.RoleAssignment(
      envName,
      {
        principalId,
        scope: container.id,
        roleDefinitionId: (
          await authorization.getRoleDefinition(
            {
              // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
              roleDefinitionId: "ba92f5b4-2d11-453d-a403-e96b0029c9fe", // "Storage Blob Data Contributor",
              scope: subScope,
            },
            pulumiOpts,
          )
        ).id,
        principalType,
      },
      pulumiOpts,
    );
  } else {
    // Create dedicated SA, since Pulumi backend without MSI auth will need to use storage-account-wide key
    ({ principalId, clientId } = auth);
    accountName = resourceGroupName.replace(/[-_]/g, "");
    containerName = "cicd";
    principalType = authorization.PrincipalType.ServicePrincipal;
    const sa = new storage.StorageAccount(
      resID,
      {
        resourceGroupName: rg.name,
        accountName,
        kind: storage.Kind.StorageV2,
        sku: {
          name: storage.SkuName.Standard_RAGRS,
        },
        allowBlobPublicAccess: false,
        enableHttpsTrafficOnly: true,
        allowSharedKeyAccess: true,
        minimumTlsVersion: storage.MinimumTlsVersion.TLS1_2,
      },
      pulumiOpts,
    );

    // Enable blob versioning for this SA.
    new storage.BlobServiceProperties(
      resID,
      {
        resourceGroupName: rg.name,
        accountName: sa.name,
        blobServicesName: "default",
        isVersioningEnabled: true,
        // If we don't supply cors + deleteRetentionPolicy, we will get config drift.
        cors: {
          corsRules: [],
        },
        deleteRetentionPolicy: {
          enabled: false,
        },
      },
      pulumiOpts,
    );
    accountKey = sa.name.apply(
      async (saName) =>
        (
          await storage.listStorageAccountKeys(
            {
              resourceGroupName,
              accountName: saName,
            },
            pulumiOpts,
          )
        ).keys[0].value,
    );
    new storage.BlobContainer(
      resID,
      {
        resourceGroupName: rg.name,
        accountName: sa.name,
        containerName,
        publicAccess: storage.PublicAccess.None,
        // These will appear to drift config at some point
        defaultEncryptionScope: "$account-encryption-key",
        denyEncryptionScopeOverride: false,
      },
      pulumiOpts,
    );
  }

  // Notice that we don't need to create dedicated KV, because existing KV has already been RBAC-enabled and thus allowing per-key/secret access control.
  const key = new kv.Key(
    resID,
    {
      resourceGroupName: pulumiKVInfo.rgName,
      vaultName: pulumiKVInfo.name,
      keyName: `${pulumiKVInfo.keyNamePrefix}${envName}`,
      properties: {
        kty: kv.JsonWebKeyType.RSA,
        keySize: pulumiKVInfo.encryptionKeyBits,
      },
    },
    pulumiOpts,
  );

  new authorization.RoleAssignment(
    `${envName}-kv`,
    {
      principalId,
      scope: key.id,
      roleDefinitionId: (
        await authorization.getRoleDefinition(
          {
            // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
            roleDefinitionId: "e147488a-f6f5-4113-8e2d-b22465e65bf6", // "Key Vault Crypto Service Encryption User",
            scope: subScope,
          },
          pulumiOpts,
        )
      ).id,
      principalType,
    },
    pulumiOpts,
  );

  const pipelineConfig =
    auth.type === "msi"
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        msiResource!.id.apply((msiId) =>
          clientId.apply((clientIdValue) =>
            key.keyUriWithVersion.apply((encryptionKeyURL) =>
              constructPipelineConfigString(
                clientConfig,
                accountName,
                containerName,
                encryptionKeyURL,
                clientIdValue,
                undefined,
                undefined,
                undefined,
                msiId,
              ),
            ),
          ),
        )
      : clientId.apply((clientIdValue) =>
          key.keyUriWithVersion.apply((encryptionKeyURL) =>
            auth.keyPEM.apply((keyPEM) =>
              auth.certPEM.apply((certPEM) =>
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                accountKey!.apply((accountKeyValue) =>
                  constructPipelineConfigString(
                    clientConfig,
                    accountName,
                    containerName,
                    encryptionKeyURL,
                    clientIdValue,
                    keyPEM,
                    certPEM,
                    accountKeyValue,
                    undefined,
                  ),
                ),
              ),
            ),
          ),
        );

  const cicdKVID = `${envName}-cicd-kv`;
  const pipelineConfigSecret = new kv.Secret(
    cicdKVID,
    {
      resourceGroupName: pulumiKVInfo.rgName,
      vaultName: pulumiKVInfo.name,
      secretName: `${pulumiKVInfo.secretNamePrefix}${envName}`,
      properties: {
        value: pipelineConfig,
      },
    },
    pulumiOpts,
  );

  new authorization.RoleAssignment(
    cicdKVID,
    {
      principalId: envSpecificPipelineConfigReader.principalId,
      scope: pipelineConfigSecret.id,
      roleDefinitionId: (
        await authorization.getRoleDefinition(
          {
            // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
            roleDefinitionId: "4633458b-17de-408a-b874-0445c86b69e6", // "Key Vault Secrets User",
            scope: subScope,
          },
          pulumiOpts,
        )
      ).id,
      principalType: envSpecificPipelineConfigReader.principalType,
    },
    pulumiOpts,
  );

  return {
    msiResource,
    clientId,
    principalId,
    principalType,
    accountName,
    accountKey,
    containerName,
    keyURI: key.keyUriWithVersion,
    pipelineConfigSecretURI:
      pipelineConfigSecret.properties.secretUriWithVersion,
  };
};

const constructPipelineConfigString = (
  clientConfig: authorization.GetClientConfigResult,
  storageAccountName: string,
  storageContainerName: string,
  encryptionKeyURL: string,
  clientId: string,
  keyPEM: string | undefined,
  certPEM: string | undefined,
  storageAccountKey: string | undefined,
  msiResID: string | undefined,
) => {
  const retVal: config.PipelineConfig = {
    backend: {
      storageAccountName,
      storageContainerName,
      encryptionKeyURL,
    },
    azure: {
      tenantId: clientConfig.tenantId,
      subscriptionId: clientConfig.subscriptionId,
    },
    auth:
      keyPEM && certPEM && storageAccountKey
        ? {
            type: "sp",
            clientId,
            keyPEM,
            certPEM,
            storageAccountKey,
          }
        : {
            type: "msi",
            clientId,
            resourceId: msiResID!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
          },
  };
  return JSON.stringify(retVal);
};

export default createResourcesForSingleEnv;
