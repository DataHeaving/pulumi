import * as auth from "@azure/core-auth";
import * as http from "@azure/core-http";
import * as resources from "@azure/arm-resources";
import * as storage from "@azure/arm-storage";
import * as kv from "@azure/arm-keyvault-profile-2020-09-01-hybrid";
import * as secrets from "@azure/keyvault-secrets";
import * as keys from "@azure/keyvault-keys";
import {
  getSecretValue,
  SecretDoesNotExistError,
} from "@data-heaving/azure-kv-secret";
import * as utils from "@data-heaving/common";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as common from "./common";

export interface Inputs {
  credentials: auth.TokenCredential;
  azure: pulumiAzure.AzureCloudInformationFull;
  principalId: string;
  organization: OrganizationInfo;
  spAuthStorageConfig: SPAuthStorageConfig | undefined;
  pulumiEncryptionKeyBits: number;
}

export interface OrganizationInfo {
  name: string;
  location: string;
}

export interface SPAuthStorageConfig {
  keyPEM: string;
  certPEM: string;
  configReaderPrincipalId: string;
}

export const ensureRequireCloudResourcesForPulumiStateExist = async (
  inputs: Inputs,
): Promise<{
  cicdRGName: string;
  kvName: string;
  backendConfig: pulumiAzure.PulumiAzureBackendConfig;
  backendStorageAccountKey: string;
}> => {
  const { organization } = inputs;
  const clientArgs = [inputs.credentials, inputs.azure.subscriptionId] as const;
  // Upsert resource group
  const cicdRGName = await ensureResourceGroupExists(clientArgs, organization);

  const storageContainerName = "bootstrap";
  const [{ kv, key }, storageAccountInfo] = await Promise.all([
    ensureKeyVaultIsConfigured(
      clientArgs,
      inputs,
      cicdRGName,
      storageContainerName,
    ),
    ensureStorageAccountIsConfigured(
      clientArgs,
      organization,
      cicdRGName,
      storageContainerName,
    ),
  ]);

  return {
    cicdRGName,
    kvName: kv.name,
    backendConfig: {
      storageAccountName: storageAccountInfo.storageAccountName,
      storageContainerName,
      ...key,
    },
    backendStorageAccountKey: storageAccountInfo.storageAccountKey,
  };
};

const ensureResourceGroupExists = async (
  clientArgs: common.ClientArgs,
  { name: organization, location }: Inputs["organization"],
) =>
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  (
    await new resources.ResourceManagementClient(
      ...clientArgs,
    ).resourceGroups.createOrUpdate(`${organization}-cicd`, { location })
  ).name!;

const ensureStorageAccountIsConfigured = async (
  clientArgs: common.ClientArgs,
  { name: organization, location }: Inputs["organization"],
  rgName: string,
  containerName: string,
) => {
  const { storageAccounts, blobServices, blobContainers } =
    new storage.StorageManagementClient(...clientArgs);
  const updateArgs: storage.StorageManagementModels.StorageAccountUpdateParameters =
    {
      accessTier: "Cool",
      allowBlobPublicAccess: false,
      allowSharedKeyAccess: true, // Pulumi backend requires this, for more info see https://github.com/google/go-cloud/blob/master/blob/azureblob/azureblob.go#L162
      enableHttpsTrafficOnly: true,
      minimumTlsVersion: "TLS1_2",
    };
  const saName = `${organization.replace(/[-_]/g, "")}cicd`;

  await ((await storageAccounts.checkNameAvailability(saName)).nameAvailable ===
  true
    ? storageAccounts.create(rgName, saName, {
        ...updateArgs,
        location,
        kind: "StorageV2",
        sku: {
          name: "Standard_GRS",
        },
      })
    : storageAccounts.update(rgName, saName, updateArgs));

  // Enable blob versioning for SA
  await blobServices.setServiceProperties(rgName, saName, {
    isVersioningEnabled: true,
  });

  // Upsert container for Pulumi state in SA (notice that this time just using 'create' is enough, unlike with storage account)
  await blobContainers.create(rgName, saName, containerName, {
    publicAccess: "None",
  });

  return {
    storageAccountName: saName,
    storageAccountKey:
      (await storageAccounts.listKeys(rgName, saName)).keys?.[0]?.value ?? "",
  };
};

const ensureKeyVaultIsConfigured = async (
  clientArgs: common.ClientArgs,
  {
    organization: { name: organization, location },
    azure: { tenantId },
    principalId,
    spAuthStorageConfig,
    pulumiEncryptionKeyBits,
  }: Inputs,
  rgName: string,
  keyName: string,
) => {
  const { vaults } = new kv.KeyVaultManagementClient(...clientArgs);

  const vaultName = constructVaultName(organization);
  const vault = await vaults.createOrUpdate(rgName, vaultName, {
    location,
    properties: {
      sku: {
        name: "standard",
      },
      tenantId,
      enabledForDeployment: false,
      enabledForDiskEncryption: false,
      enabledForTemplateDeployment: false,
      enableRbacAuthorization: true,
    },
  });

  const kvURL = vault.properties.vaultUri!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
  const vaultID = vault.id!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

  // Enable managing key vault for this SP
  await common.upsertRoleAssignment(
    clientArgs,
    vaultID,
    // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
    "00482a5a-887f-4fb3-b363-3b7fe8e74483", // "Key Vault Administrator"
    principalId,
  );

  // The "getKeys" method exists only for "KeyVaultClient" class of "@azure/keyvault-keys" module.
  // However, the class is not exported -> therefore we have to make this ugly hack
  const keyClient = new keys.KeyClient(kvURL, clientArgs[0]);
  let key = await retryIf403(
    () => keyClient.getKey(keyName),
    "Waiting for key vault role assignment to propagate for encryption key...",
  );
  if (!key) {
    key = await keyClient.createRsaKey(keyName, {
      keySize: pulumiEncryptionKeyBits,
    });
  }
  // Store key + cert pem, if specified
  if (spAuthStorageConfig) {
    const secretName = constructBootstrapperAppAuthSecretName();
    await common.upsertRoleAssignment(
      clientArgs,
      `${vaultID}/secrets/${secretName}`,
      // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
      "4633458b-17de-408a-b874-0445c86b69e6", // "Key Vault Secrets User",
      spAuthStorageConfig.configReaderPrincipalId,
    );
    const existingSecretValue = await retryIf403(
      () =>
        tryGetSecretValue(clientArgs[0], {
          kvURL,
          secretName,
        }),
      "Waiting for key vault role assignment to propagate for bootstrapper app auth secret...",
    );
    const secretValue = `${spAuthStorageConfig.keyPEM}${spAuthStorageConfig.certPEM}`;
    if (existingSecretValue !== secretValue) {
      await new secrets.SecretClient(kvURL, clientArgs[0]).setSecret(
        secretName,
        secretValue,
      );
    }
  }

  return {
    kv: {
      name: vaultName,
    },
    key: {
      encryptionKeyURL: key.id!, // eslint-disable-line @typescript-eslint/no-non-null-assertion
    },
  };
};

const retryIf403 = async <T>(getAction: () => Promise<T>, message: string) => {
  let tryAgain = false;
  let retVal: T | undefined;
  do {
    try {
      retVal = await getAction();
      tryAgain = false;
    } catch (e) {
      if (e instanceof http.RestError && e.code === "Forbidden") {
        tryAgain = true;
      } else {
        throw e;
      }
    }
    if (tryAgain) {
      // eslint-disable-next-line no-console
      console.info(message);
      await utils.sleep(10 * 1000);
    }
  } while (tryAgain);

  return retVal;
};

export const constructVaultName = (organization: string) =>
  `${organization}-cicd`;

export const constructBootstrapperAppAuthSecretName = () => "bootstrapper-auth";

export const tryGetSecretValue = async (
  ...args: Parameters<typeof getSecretValue>
) => {
  let secretValue: string | undefined;
  try {
    secretValue = await getSecretValue(...args);
  } catch (e) {
    if (!isSecretNotFoundError(e)) {
      throw e;
    }
  }

  return secretValue;
};

const isSecretNotFoundError = (error: unknown) =>
  error instanceof SecretDoesNotExistError ||
  (error instanceof http.RestError && error.code === "SecretNotFound");
