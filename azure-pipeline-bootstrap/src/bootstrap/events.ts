import { AuthorizationManagementModels } from "@azure/arm-authorization";
import { KeyVaultManagementModels } from "@azure/arm-keyvault-profile-2020-09-01-hybrid";
import { ResourceManagementModels } from "@azure/arm-resources";
import { StorageManagementModels } from "@azure/arm-storage";
import { KeyVaultKey } from "@azure/keyvault-keys";
import * as common from "@data-heaving/common";
import * as setup from "@data-heaving/pulumi-azure-pipeline-setup";
import * as types from "./types";

// This is virtual interface - no instances implementing this are ever created
export interface VirtualBootstrapEvents {
  // Generic
  afterResolvingConfigReaderPrincipal: setup.EnvSpecificPipelineConfigReader;

  // AD
  afterADApplicationExists: types.UpsertResult<{
    application: types.Application;
  }>;
  afterADServicePrincipalExists: types.UpsertResult<{
    servicePrincipal: types.ServicePrincipal;
  }>;
  beforeApplicationCredentialsExists: types.UpsertResult<{
    application: types.Application;
    credential: CredentialInfo;
    waitTimeInSecondsIfCreated: number;
  }>;
  beforeApplicationHasEnoughPermissions: types.UpsertResult<{
    application: types.Application;
    permissionsToAssign: ReadonlyArray<types.ApplicationRequiredResourceAccess>;
    waitTimeInSecondsIfCreated: number;
  }>;
  beforeAdminConsentGranted: types.UpsertResult<{
    servicePrincipal: types.ServicePrincipal;
    permissionsToGrant: ReadonlyArray<types.ApplicationRequiredResourceAccess>;
  }>;

  // ARM
  bootstrapperRoleAssignmentCreatedOrUpdated: AuthorizationManagementModels.RoleAssignment;
  resourceGroupCreatedOrUpdated: ResourceManagementModels.ResourceGroupsCreateOrUpdateResponse;
  storageAccountCreatedOrUpdated:
    | StorageManagementModels.StorageAccountsUpdateResponse
    | StorageManagementModels.StorageAccountsCreateResponse;
  storageAccountBlobServicesConfigured: StorageManagementModels.BlobServicesSetServicePropertiesResponse;
  storageAccountContainerCreatedOrUpdated: StorageManagementModels.BlobContainersCreateResponse;
  keyVaultCreatedOrUpdated: KeyVaultManagementModels.VaultsCreateOrUpdateResponse;
  keyVaultAdminRoleAssignmentCreatedOrUpdated: AuthorizationManagementModels.RoleAssignment;
  keyVaultAuthenticationSecretRoleAssignmentCreatedOrUpdated: AuthorizationManagementModels.RoleAssignment;

  // KV
  keyCreatedOrUpdated: types.UpsertResult<{ key: KeyVaultKey }>;
  authenticationSecretCreatedOrUpdated: types.UpsertResult<{
    secretName: string;
    secretValue: string;
  }>;
}

export type CredentialInfo = Pick<
  types.ApplicationCredential,
  "key" | "keyId" | "type" | "usage" | "customKeyIdentifier"
>;

export type BootstrapEventEmitter = common.EventEmitter<VirtualBootstrapEvents>;

export const createBootstrapEventEmitterBuilder = () =>
  new common.EventEmitterBuilder<VirtualBootstrapEvents>();

export const consoleLoggingBootstrapEventEmitterBuilder = (
  logSubscriptionId?: boolean,
  logMessagePrefix?: Parameters<typeof common.createConsoleLogger>[0],
  builder?: common.EventEmitterBuilder<VirtualBootstrapEvents>,
  consoleAbstraction?: common.ConsoleAbstraction,
) => {
  if (!builder) {
    builder = createBootstrapEventEmitterBuilder();
  }

  const logger = common.createConsoleLogger(
    logMessagePrefix,
    consoleAbstraction,
  );

  const processStringWithSubscriptionID = (str: string | undefined) => {
    if (str && logSubscriptionId !== true) {
      // Remove first 51 characters ("/subscriptions/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
      str = str.substr(51);
      if (str.length === 0) {
        str = "whole subscription";
      }
    }
    return str;
  };

  const logRoleAssignment = (
    assignment: AuthorizationManagementModels.RoleAssignment,
    description: string,
  ) =>
    logger(
      `Successfully assigned ${description}: ${assignment.principalId} (${
        assignment.principalType
      }) to role ${lastItem(
        assignment.roleDefinitionId?.split("/"),
      )} on scope ${processStringWithSubscriptionID(assignment.scope)}`,
    );

  builder.addEventListener("afterResolvingConfigReaderPrincipal", (arg) =>
    logger(
      `Any stored SP authentication secrets will be readable by: ${JSON.stringify(
        arg,
      )}`,
    ),
  );

  builder.addEventListener("afterADApplicationExists", (arg) =>
    logger(
      `Successfully ${
        arg.createNew ? "created" : "configured"
      } application with ID ${arg.application.id} and display name "${
        arg.application.displayName
      }".`,
    ),
  );

  builder.addEventListener("afterADServicePrincipalExists", (arg) =>
    logger(
      `Successfully ${
        arg.createNew ? "created" : "configured"
      } service principal with ID ${arg.servicePrincipal.id} connected to app ${
        arg.servicePrincipal.appId
      }.`,
    ),
  );

  builder.addEventListener("beforeApplicationCredentialsExists", (arg) =>
    logger(
      `For app ${arg.application.id}, will${
        arg.createNew ? "" : " not"
      } create credentials with ID ${arg.credential.keyId} and thumbprint ${
        arg.credential.customKeyIdentifier
      }.${
        arg.createNew
          ? `\nWaiting ${arg.waitTimeInSecondsIfCreated} seconds for credentials to sync.`
          : ""
      }`,
    ),
  );

  builder.addEventListener("beforeApplicationHasEnoughPermissions", (arg) =>
    logger(
      `For app ${arg.application.id}, will${
        arg.createNew ? "" : " not"
      } add permissons: ${JSON.stringify(arg.permissionsToAssign)}.${
        arg.createNew
          ? `\nWill wait ${arg.waitTimeInSecondsIfCreated} seconds for permissions to sync.`
          : ""
      }`,
    ),
  );

  builder.addEventListener("beforeAdminConsentGranted", (arg) =>
    logger(
      `For SP ${arg.servicePrincipal.id}, will${
        arg.createNew ? "" : " not"
      } grant admin consent for permissions: ${JSON.stringify(
        arg.permissionsToGrant,
      )}.`,
    ),
  );

  builder.addEventListener(
    "bootstrapperRoleAssignmentCreatedOrUpdated",
    (arg) => logRoleAssignment(arg, "bootstrapper app resource privileges"),
  );

  builder.addEventListener("resourceGroupCreatedOrUpdated", (arg) =>
    logger(`Processed resource group "${arg.name}" to "${arg.location}".`),
  );

  builder.addEventListener("storageAccountCreatedOrUpdated", (arg) =>
    logger(`Processed storage account ${arg.name}.`),
  );

  builder.addEventListener("storageAccountBlobServicesConfigured", (arg) =>
    logger(
      `Configured storage account blob services: ${JSON.stringify(
        pick(
          arg,
          "isVersioningEnabled",
          "deleteRetentionPolicy",
          "cors",
          "containerDeleteRetentionPolicy",
          "restorePolicy",
          "sku",
        ),
      )}`,
    ),
  );

  builder.addEventListener("storageAccountContainerCreatedOrUpdated", (arg) =>
    logger(
      `Processed storage account container ${JSON.stringify(
        pick(arg, "name", "publicAccess"),
      )}`,
    ),
  );

  builder.addEventListener("keyVaultCreatedOrUpdated", (arg) =>
    logger(
      `Processed key vault ${JSON.stringify(
        Object.assign(
          pick(arg, "name"),
          pick(
            arg.properties,
            "sku",
            "enablePurgeProtection",
            "enableRbacAuthorization",
            "enableSoftDelete",
            "enabledForDeployment",
            "enabledForDiskEncryption",
            "enabledForTemplateDeployment",
            "softDeleteRetentionInDays",
          ),
        ),
      )}`,
    ),
  );

  builder.addEventListener(
    "keyVaultAdminRoleAssignmentCreatedOrUpdated",
    (arg) => logRoleAssignment(arg, "bootstrapper app KV privileges"),
  );

  builder.addEventListener(
    "keyVaultAuthenticationSecretRoleAssignmentCreatedOrUpdated",
    (arg) =>
      logRoleAssignment(arg, "bootstrapper app auth retriever privileges"),
  );

  builder.addEventListener("keyCreatedOrUpdated", ({ createNew, key }) =>
    logger(
      `Successfully ${createNew ? "created" : "retrieved"} key vault key "${
        key.name
      }" of type "${key.keyType}" having ${
        (key.key?.n?.byteLength ?? 0) * 8
      } bits.`,
    ),
  );

  builder.addEventListener(
    "authenticationSecretCreatedOrUpdated",
    ({ createNew, secretName }) =>
      logger(
        `Successfully ${
          createNew ? "set" : "ensured existence of "
        } key vault secret "${secretName}"`,
      ),
  );

  return builder;
};

const lastItem = <T>(array: ReadonlyArray<T> | undefined) =>
  array?.[array.length - 1];

// From https://stackoverflow.com/a/56592365
// TODO move these to @data-heaving/common
const pick = <T, TKey extends keyof T>(
  obj: T | undefined,
  ...keys: ReadonlyArray<TKey>
) =>
  (obj
    ? Object.fromEntries(
        keys.filter((key) => key in obj).map((key) => [key, obj[key]]),
      )
    : {}) as Partial<Pick<T, TKey>>;

// const inclusivePick = <T, TKey extends keyof T>(
//   obj: T,
//   ...keys: ReadonlyArray<TKey>
// ) => Object.fromEntries(keys.map((key) => [key, obj[key]])) as Pick<T, TKey>;

// const omit = <T, TKey extends keyof T>(obj: T, ...keys: ReadonlyArray<TKey>) =>
//   Object.fromEntries(
//     Object.entries(obj).filter(([key]) => !keys.includes(key as TKey)),
//   ) as Omit<T, TKey>;
