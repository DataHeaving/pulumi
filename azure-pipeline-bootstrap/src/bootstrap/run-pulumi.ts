import * as auth from "@azure/core-auth";
import * as http from "@azure/core-http";
import * as resources from "@azure/arm-resources";
import * as storage from "@azure/arm-storage";
import * as kv from "@azure/arm-keyvault-profile-2020-09-01-hybrid";
import * as secrets from "@azure/keyvault-secrets";
import * as keys from "@azure/keyvault-keys";
import * as secretGetting from "@data-heaving/azure-kv-secret";
import * as common from "@data-heaving/common";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as pipelineConfig from "@data-heaving/pulumi-azure-pipeline-config";
import * as events from "./events";
import * as utils from "./run-common";

export interface Inputs {
  eventEmitter: events.BootstrapEventEmitter;
  credentials: auth.TokenCredential;
  azure: pulumiAzure.AzureCloudInformationFull;
  principalId: string;
  organization: OrganizationInfo;
  spAuthStorageConfig: SPAuthStorageConfig | undefined;
  pulumiEncryptionKeyBits: number;
  storeBootstrapPipelineConfigToKV:
    | {
        secretName: string;
        clientId: string;
        resourceId: string;
      }
    | undefined;
}

export interface Outputs {
  cicdRGName: string;
  kvName: string;
  backendConfig: pulumiAzure.PulumiAzureBackendConfig;
  backendStorageAccountKey: string;
}

export interface OrganizationInfo {
  name: string;
  location: string;
}

export interface SPAuthStorageConfig {
  keyPEM: string;
  certPEM: string;
  configReaderPrincipalId: string;
  configSecretName: string;
}

export const ensureRequireCloudResourcesForPulumiStateExist = async (
  inputs: Inputs,
): Promise<Outputs> => {
  const { eventEmitter, organization } = inputs;
  const clientArgs = [inputs.credentials, inputs.azure.subscriptionId] as const;
  // Upsert resource group
  const cicdRGName = await ensureResourceGroupExists(
    eventEmitter,
    clientArgs,
    organization,
  );

  const storageContainerName = "bootstrap";
  const [kvResult, saResult] = await Promise.all([
    ensureKeyVaultIsConfigured(
      clientArgs,
      inputs,
      cicdRGName,
      storageContainerName,
    ),
    ensureStorageAccountIsConfigured(
      eventEmitter,
      clientArgs,
      organization,
      cicdRGName,
      storageContainerName,
    ),
  ]);

  await storeBootstrapAuthToKVIfNeeded(inputs, saResult, kvResult);

  const { vaultName, encryptionKeyURL } = kvResult;
  const { storageAccountName, storageAccountKey } = saResult;
  return {
    cicdRGName,
    kvName: vaultName,
    backendConfig: {
      storageAccountName,
      storageContainerName,
      encryptionKeyURL,
    },
    backendStorageAccountKey: storageAccountKey,
  };
};

const ensureResourceGroupExists = async (
  eventEmitter: events.BootstrapEventEmitter,
  clientArgs: utils.ClientArgs,
  { name: organization, location }: Inputs["organization"],
) => {
  const rg = await new resources.ResourceManagementClient(
    ...clientArgs,
  ).resourceGroups.createOrUpdate(`${organization}-cicd`, { location });
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const rgName = rg.name!;
  eventEmitter.emit("resourceGroupCreatedOrUpdated", rg);
  return rgName;
};

const ensureStorageAccountIsConfigured = async (
  eventEmitter: events.BootstrapEventEmitter,
  clientArgs: utils.ClientArgs,
  { name: organization, location }: Inputs["organization"],
  rgName: string,
  storageContainerName: string,
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

  eventEmitter.emit(
    "storageAccountCreatedOrUpdated",
    await ((
      await storageAccounts.checkNameAvailability(saName)
    ).nameAvailable === true
      ? storageAccounts.create(rgName, saName, {
          ...updateArgs,
          location,
          kind: "StorageV2",
          sku: {
            name: "Standard_GRS",
          },
        })
      : storageAccounts.update(rgName, saName, updateArgs)),
  );

  await Promise.all([
    // Enable blob versioning for SA
    (async () =>
      eventEmitter.emit(
        "storageAccountBlobServicesConfigured",
        await blobServices.setServiceProperties(rgName, saName, {
          isVersioningEnabled: true,
        }),
      ))(),
    // Upsert container for Pulumi state in SA (notice that this time just using 'create' is enough, unlike with storage account)
    (async () =>
      eventEmitter.emit(
        "storageAccountContainerCreatedOrUpdated",
        await blobContainers.create(rgName, saName, storageContainerName, {
          publicAccess: "None",
        }),
      ))(),
  ]);

  return {
    storageAccountName: saName,
    storageContainerName,
    storageAccountKey:
      (await storageAccounts.listKeys(rgName, saName)).keys?.[0]?.value ?? "",
  };
};

const ensureKeyVaultIsConfigured = async (
  clientArgs: utils.ClientArgs,
  {
    eventEmitter,
    organization: { name: organization, location },
    azure: { tenantId },
    principalId,
    spAuthStorageConfig,
    pulumiEncryptionKeyBits,
  }: Omit<Inputs, "storeBootstrapAuthToKV">,
  rgName: string,
  storageContainerName: string,
) => {
  const { vaults } = new kv.KeyVaultManagementClient(...clientArgs);

  const vaultName = constructVaultName(organization);
  const kvResult = await vaults.createOrUpdate(rgName, vaultName, {
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
      createMode: "recover", // In order to recover previously deleted soft-deletable vaults
    },
  });
  const {
    id,
    properties: { vaultUri },
  } = kvResult;

  eventEmitter.emit("keyVaultCreatedOrUpdated", kvResult);

  const kvURL = vaultUri!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
  const vaultID = id!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

  // Enable managing key vault for this SP
  eventEmitter.emit(
    "keyVaultAdminRoleAssignmentCreatedOrUpdated",
    await utils.upsertRoleAssignment(
      clientArgs,
      vaultID,
      // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
      "00482a5a-887f-4fb3-b363-3b7fe8e74483", // "Key Vault Administrator"
      principalId,
    ),
  );

  // The "getKeys" method exists only for "KeyVaultClient" class of "@azure/keyvault-keys" module.
  // However, the class is not exported -> therefore we have to make this ugly hack
  const keyClient = new keys.KeyClient(kvURL, clientArgs[0]);
  let key: keys.KeyVaultKey | undefined;
  try {
    key = await retryIf403(
      () => keyClient.getKey(storageContainerName),
      "Waiting for key vault role assignment to propagate for encryption key...",
    );
  } catch (e) {
    if (!(e instanceof http.RestError && e.code === "KeyNotFound")) {
      throw e;
    }
  }
  {
    let createNew = false;
    if (!key) {
      key = await keyClient.createRsaKey(storageContainerName, {
        keySize: pulumiEncryptionKeyBits,
      });
      createNew = true;
    }
    eventEmitter.emit("keyCreatedOrUpdated", {
      createNew,
      key,
    });
  }
  const encryptionKeyURL = key.id!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
  // Store key + cert pem, if specified
  if (spAuthStorageConfig) {
    const { configSecretName: secretName } = spAuthStorageConfig;
    eventEmitter.emit(
      "keyVaultAuthenticationSecretRoleAssignmentCreatedOrUpdated",
      await utils.upsertRoleAssignment(
        clientArgs,
        `${vaultID}/secrets/${secretName}`,
        // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
        "4633458b-17de-408a-b874-0445c86b69e6", // "Key Vault Secrets User",
        spAuthStorageConfig.configReaderPrincipalId,
      ),
    );
    const { createNew, secretValue } = await upsertSecret(
      clientArgs[0],
      kvURL,
      secretName,
      `${spAuthStorageConfig.keyPEM}${spAuthStorageConfig.certPEM}`,
    );
    eventEmitter.emit("authenticationSecretCreatedOrUpdated", {
      createNew,
      secretName,
      secretValue,
    });
  }

  return {
    kvURL,
    vaultName,
    encryptionKeyURL, // eslint-disable-line @typescript-eslint/no-non-null-assertion
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
      await common.sleep(10 * 1000);
    }
  } while (tryAgain);

  return retVal;
};

export const constructVaultName = (organization: string) =>
  `${organization}-cicd`;

export const tryGetSecretValue = async (
  ...args: Parameters<typeof secretGetting.getSecretValue>
) => {
  let secretValue: string | undefined;
  try {
    secretValue = await secretGetting.getSecretValue(...args);
  } catch (e) {
    if (!isSecretNotFoundError(e)) {
      throw e;
    }
  }

  return secretValue;
};

const isSecretNotFoundError = (error: unknown) =>
  error instanceof secretGetting.SecretDoesNotExistError ||
  (error instanceof http.RestError && error.code === "SecretNotFound");

const upsertSecret = async (
  credential: auth.TokenCredential,
  kvURL: string,
  secretName: string,
  secretValue: string,
) => {
  const existingSecretValue = await retryIf403(
    () =>
      tryGetSecretValue(credential, {
        kvURL,
        secretName,
      }),
    "Waiting for key vault role assignment to propagate for bootstrapper app auth secret...",
  );
  const createNew = existingSecretValue !== secretValue;
  if (createNew) {
    await new secrets.SecretClient(kvURL, credential).setSecret(
      secretName,
      secretValue,
    );
  }

  return { createNew, secretValue };
};

const storeBootstrapAuthToKVIfNeeded = async (
  inputs: Inputs,
  {
    storageAccountName,
    storageContainerName,
    storageAccountKey,
  }: common.DePromisify<ReturnType<typeof ensureStorageAccountIsConfigured>>,
  {
    kvURL,
    encryptionKeyURL,
  }: common.DePromisify<ReturnType<typeof ensureKeyVaultIsConfigured>>,
) => {
  const { storeBootstrapPipelineConfigToKV: storeBootstrapAuthToKV } = inputs;
  if (storeBootstrapAuthToKV) {
    const spPipelineAuth: pipelineConfig.PipelineConfig = {
      auth: inputs.spAuthStorageConfig
        ? {
            type: "sp",
            clientId: storeBootstrapAuthToKV.clientId,
            keyPEM: inputs.spAuthStorageConfig.keyPEM,
            certPEM: inputs.spAuthStorageConfig.certPEM,
            storageAccountKey,
          }
        : {
            type: "msi",
            clientId: storeBootstrapAuthToKV.clientId,
            resourceId: storeBootstrapAuthToKV.resourceId,
          },
      azure: {
        tenantId: inputs.azure.tenantId,
        subscriptionId: inputs.azure.subscriptionId,
      },
      backend: {
        storageAccountName,
        storageContainerName,
        encryptionKeyURL,
      },
    };
    const { secretName } = storeBootstrapAuthToKV;
    const { createNew, secretValue } = await upsertSecret(
      inputs.credentials,
      kvURL,
      secretName,
      JSON.stringify(spPipelineAuth),
    );
    inputs.eventEmitter.emit("bootstrapperPipelineAuthSecretCreatedOrUpdated", {
      createNew,
      secretName,
      secretValue,
    });
  }
};
