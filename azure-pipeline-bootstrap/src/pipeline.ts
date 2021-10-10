import * as common from "@data-heaving/common";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as pipeline from "@data-heaving/pulumi-azure-pipeline";
import * as pulumiSetup from "@data-heaving/pulumi-azure-pipeline-setup";
import * as bootstrap from "./bootstrap";
import * as types from "./types";
import * as events from "./events";
import * as registration from "./provider-registration";

export interface Inputs {
  eventEmitters: PulumiPipelineEventEmitters;
  /**
   * If this is true, then Pulumi command `"up"` is executed. Otherwise, the Pulumi command `"preview"` is executed.
   */
  doChanges: boolean;
  credentials: bootstrap.BootstrappingCredentials;
  bootstrapperApp: BootstrapperApp;
  azure: pulumiAzure.AzureCloudInformationFull;
  targetResources: pulumiSetup.TargetResourcesConfig;
  organization: types.Organization;
  pipelineConfigs: {
    pulumiEncryptionKeyBitsForBootstrapper: number;
    pulumiEncryptionKeyBitsForEnvSpecificPipeline: number;
  };
  namingConventions?: NamingConventions;
  bootstrapperPipelineConfigSecretName?: string | undefined;
}

export type PulumiPipelineEventEmitters = {
  bootstrapEventEmitter: bootstrap.BootstrapEventEmitter;
  pulumiEventEmitters: pipeline.PulumiPipelineEventEmitters;
  pipelineEventEmitter: events.PipelineBootstrapEventEmitter;
};

export interface NamingConventions {
  /**
   * This is used if:
   * - bootstrapperApp is MSI, or
   * - bootstrapperApp is SP, but env-specific Pulumi pipelines authentication is MSI (envSpecificPulumiPipelineSPAuth is set to undefined).
   *
   * Default value is `"cicd-env-"`.
   */
  storageContainerPrefixString?: string;
  /**
   * This is always needed. Default value is `"cicd-env-"`.
   */
  keyNamePrefix?: string;
  /**
   * This is always needed. Default value is `"cicd-env-"`.
   */
  secretNamePrefix?: string;
}

const DEFAULT_STORAGE_CONTAINER_PREFIX = "cicd-env-";
const DEFAULT_KEY_NAME_PREFIX = "cicd-env-";
const DEFAULT_SECRET_NAME_PREFIX = "cicd-env-";

export type BootstrapperApp = BootstrapperAppSP | BootstrapperAppMSI;

export type BootstrapperAppSP = Omit<
  bootstrap.BootstrapperAppSP,
  "appRequiredPermissions"
> & {
  /**
   * This exists only for SP info, as MSIs are unable to do any AAD changes.
   * Set this to non-undefined value in order to make env-specific Pulumi pipelines authenticate using SP.
   */
  envSpecificPulumiPipelineSPAuth?: pulumiSetup.SPCertificateInfo | undefined;
};
export type BootstrapperAppMSI = bootstrap.BootstrapperAppMSI;

export const main = async ({
  eventEmitters,
  doChanges,
  credentials,
  bootstrapperApp,
  organization,
  azure,
  targetResources,
  namingConventions,
  pipelineConfigs,
  bootstrapperPipelineConfigSecretName,
}: Inputs) => {
  const { bootstrapEventEmitter, pipelineEventEmitter, pulumiEventEmitters } =
    eventEmitters;
  const {
    cicdRGName,
    kvName,
    pulumiConfigInfo,
    envSpecificPipelineConfigReader,
    bootstrapAuth,
    keyAndCertPath,
  } = await bootstrap.performBootstrap({
    eventEmitter: bootstrapEventEmitter,
    credentials,
    azure,
    organization,
    pulumiEncryptionKeyBits:
      pipelineConfigs.pulumiEncryptionKeyBitsForBootstrapper,
    bootstrapperApp: getBootstrapAppForSetup(bootstrapperApp, organization),
    bootstrapperPipelineConfigSecretName,
  });
  pipelineEventEmitter?.emit("beforeRunningPulumiPortion", {
    organization: common.deepCopy(organization),
    doChanges,
  });
  // For some reason, due some TS compiler bug, we must specify generic argument explicitly.
  const command = doChanges ? ("up" as const) : ("preview" as const);
  return await pipeline.runPulumiPipeline<typeof command>(
    {
      pulumi: {
        ...pulumiConfigInfo,
        programArgs: {
          projectName: "bootstrap",
          stackName: "main",
          program: () => {
            // Create necessary provider namespace registrations
            handleProviderRegistrations(organization).map(
              ({ subscriptionId, resourceProviderNamespaces }) =>
                new registration.ResourceProviderRegistration(
                  new registration.ResourceProviderRegistrationProvider(
                    azure.tenantId,
                    subscriptionId,
                    bootstrapAuth,
                    keyAndCertPath,
                  ),
                  `provider-registrations-${subscriptionId}`,
                  {
                    resourceProviderNamespaces,
                  },
                ),
            );
            // Handle the CICD setup for environments
            return pulumiSetup.pulumiProgram({
              organization,
              envSpecificPipelineConfigReader,
              pulumiPipelineConfig: {
                auth:
                  bootstrapperApp.type === "sp" &&
                  bootstrapperApp.envSpecificPulumiPipelineSPAuth
                    ? {
                        type: "sp" as const,
                        certificateConfig:
                          bootstrapperApp.envSpecificPulumiPipelineSPAuth,
                      }
                    : {
                        type: "msi" as const,
                        sharedSARGName: cicdRGName,
                        sharedSAName:
                          pulumiConfigInfo.backendConfig.storageAccountName,
                        containerPrefixString:
                          namingConventions?.storageContainerPrefixString ??
                          DEFAULT_STORAGE_CONTAINER_PREFIX,
                      },
                pulumiKVInfo: {
                  rgName: cicdRGName,
                  name: kvName,
                  keyNamePrefix:
                    namingConventions?.keyNamePrefix ?? DEFAULT_KEY_NAME_PREFIX,
                  secretNamePrefix:
                    namingConventions?.secretNamePrefix ??
                    DEFAULT_SECRET_NAME_PREFIX,
                  encryptionKeyBits:
                    pipelineConfigs.pulumiEncryptionKeyBitsForEnvSpecificPipeline,
                },
              },
              targetResources,
            });
          },
        },
      },
      azure: {
        tenantId: azure.tenantId,
        // Intentionally leave out subscription ID in order to cause errors if default provider is accidentally used.
        subscriptionId: undefined,
      },
    },
    ["azure-native", "azuread", "tls"],
    command,
    pulumiEventEmitters,
  );
};

const getBootstrapAppForSetup = (
  app: BootstrapperApp,
  organization: types.Organization,
): bootstrap.BootstrapperApp => {
  let retVal: bootstrap.BootstrapperApp;
  if (app.type === "sp") {
    const graphAccess: Array<bootstrap.ApplicationResourceAccess> = [];
    if (organization.environments.length > 0) {
      if (
        app.envSpecificPulumiPipelineSPAuth !== undefined &&
        organization.environments.some((env) => !env.envSpecificAuthOverride)
      ) {
        graphAccess.push({
          type: "Role",
          id: "18a4783c-866b-4cc7-a460-3d5e5662c884", // Application.ReadWrite.OwnedBy
        });
        if (
          organization.environments.some(
            (env) =>
              ((
                env.envSpecificAuthOverride as pulumiSetup.PulumiPipelineAuthInfoSP
              )?.applicationRequiredResourceAccess?.length ?? 0) > 0,
          )
        ) {
          graphAccess.push({
            type: "Role",
            id: "06b708a9-e830-4db3-a914-8e69da51d44f", // AppRoleAssignment.ReadWrite.All
          });
        }
      }
    }

    retVal = {
      ...app,
      appRequiredPermissions:
        graphAccess.length > 0
          ? [
              {
                resourceAppId: "00000003-0000-0000-c000-000000000000", // Microsoft.Graph
                resourceAccess: graphAccess,
              },
            ]
          : [],
    };
  } else {
    retVal = app;
  }
  return retVal;
};

const handleProviderRegistrations = (organization: types.Organization) => {
  // Save organization default provider registrations
  const orgProviderRegistrations =
    organization.defaultProviderRegistrations ?? [];
  // Extract provider registration information from each environment
  const registrationNamespacesForSubscriptions = organization.environments
    .flatMap(({ providerRegistrations, subscriptionId }) =>
      (providerRegistrations
        ? Array.isArray(providerRegistrations)
          ? // If provider registrations is just string array -> return default registrations + env-specific registrations
            orgProviderRegistrations.concat(providerRegistrations)
          : // Don't prepend default registrations if so specified
            (providerRegistrations.ignoreDefaultProviderRegistrations
              ? []
              : orgProviderRegistrations
            ).concat(providerRegistrations.providerRegistrations)
        : orgProviderRegistrations
      ).map((providerRegistration) => ({
        // For each registration, extract registration namespace + subscription ID
        subscriptionId,
        providerRegistration,
      })),
    )
    // Construct record, where key is subscription ID, and value is unprocessed registration namespace array
    .reduce<Record<string, Array<string>>>(
      (
        providerRegistrationsForSubscription,
        { subscriptionId, providerRegistration },
      ) => {
        common
          .getOrAddGeneric(
            providerRegistrationsForSubscription,
            subscriptionId,
            () => [],
          )
          .push(providerRegistration);
        return providerRegistrationsForSubscription;
      },
      {},
    );
  // Finally, deduplicate registration namespaces array for each subscription, using case-insensitive string comparison
  return Object.entries(registrationNamespacesForSubscriptions).map(
    ([subscriptionId, providerRegistrations]) => ({
      subscriptionId,
      resourceProviderNamespaces: common.deduplicate(
        providerRegistrations,
        (r) => r.toLowerCase(),
      ),
    }),
  );
};
