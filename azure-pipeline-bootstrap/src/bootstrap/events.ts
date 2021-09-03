import { AuthorizationManagementModels } from "@azure/arm-authorization";
import { KeyVaultManagementModels } from "@azure/arm-keyvault-profile-2020-09-01-hybrid";
import { ResourceManagementModels } from "@azure/arm-resources";
import { StorageManagementModels } from "@azure/arm-storage";
import { KeyVaultKey } from "@azure/keyvault-keys";
import { KeyVaultSecret } from "@azure/keyvault-secrets";
import * as common from "@data-heaving/common";
import * as types from "./types";

// This is virtual interface - no instances implementing this are ever created
export interface VirtualBootstrapEvents {
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
    permissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>;
    waitTimeInSecondsIfCreated: number;
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
  keyCreatedOrUpdated: KeyVaultKey;
  authenticationSecretCreatedOrUpdated: KeyVaultSecret;
}

export type CredentialInfo = Pick<
  types.ApplicationCredential,
  "key" | "keyId" | "type" | "usage"
>;

export type BootstrapEventEmitter = common.EventEmitter<VirtualBootstrapEvents>;

export const createBootstrapEventEmitterBuilder = () =>
  new common.EventEmitterBuilder<VirtualBootstrapEvents>();

export const consoleLoggingBootstrapEventEmitterBuilder = (
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
      `Successfully ${
        arg.createNew ? "created" : "configured"
      } credentials with ID "${arg.credential.keyId}" for app ${
        arg.application.id
      }.${
        arg.createNew
          ? `\nWaiting ${arg.waitTimeInSecondsIfCreated} seconds for credentials to sync.`
          : ""
      }`,
    ),
  );

  builder.addEventListener("beforeApplicationHasEnoughPermissions", (arg) =>
    logger(
      `Successfully ${
        arg.createNew ? "created" : "configured"
      } permissions for app ${arg.application.id}: ${JSON.stringify(
        arg.permissions,
      )}.${
        arg.createNew
          ? `\nWaiting ${arg.waitTimeInSecondsIfCreated} seconds for permissions to sync.`
          : ""
      }`,
    ),
  );

  return builder;
};
