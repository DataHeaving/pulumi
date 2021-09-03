import * as id from "@azure/identity";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as pipeline from "@data-heaving/pulumi-azure-pipeline";
import * as pulumiSetup from "@data-heaving/pulumi-azure-pipeline-setup";
import * as bootstrap from "./bootstrap";

export interface Inputs {
  /**
   * If this is true, then Pulumi command `"up"` is executed. Otherwise, the Pulumi command `"preview"` is executed.
   */
  doChanges: boolean;
  credentials: id.TokenCredential;
  bootstrapperApp: BootstrapperAppSP | BootstrapperAppMSI;
  azure: pulumiAzure.AzureCloudInformationFull;
  organization: Organization;
  pipelineConfigs: {
    pulumiEncryptionKeyBitsForBootstrapper: number;
    pulumiEncryptionKeyBitsForEnvSpecificPipeline: number;
  };
  namingConventions?: NamingConventions;
}

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

export type Organization = bootstrap.OrganizationInfo &
  pulumiSetup.OrganizationInfo;

export type BootstrapperApp = BootstrapperAppSP | BootstrapperAppMSI;

export type BootstrapperAppSP = Omit<
  bootstrap.BootstrapperAppSP,
  "willNeedToCreateAADApps"
> & {
  /**
   * This exists only for SP info, as MSIs are unable to do any AAD changes.
   * Set this to non-undefined value in order to make env-specific Pulumi pipelines authenticate using SP.
   */
  envSpecificPulumiPipelineSPAuth?: pulumiSetup.SPCertificateInfo | undefined;
};
export type BootstrapperAppMSI = bootstrap.BootstrapperAppMSI;

/* eslint-disable no-console */
// TODO clean up cert files when done
export const main = async (
  {
    doChanges,
    credentials,
    bootstrapperApp,
    organization,
    azure,
    namingConventions,
    pipelineConfigs,
  }: Inputs,
  eventEmitters: PulumiPipelineEventEmitters | undefined,
) => {
  console.info("Setting up infrastructure for Pulumi...");
  const {
    cicdRGName,
    kvName,
    pulumiConfigInfo,
    envSpecificPipelineConfigReader,
  } = await bootstrap.performBootstrap({
    credentials,
    azure,
    organization,
    pulumiEncryptionKeyBits:
      pipelineConfigs.pulumiEncryptionKeyBitsForBootstrapper,
    bootstrapperApp: getBootstrapAppForSetup(bootstrapperApp),
  });
  console.info("Done."); // Don't print pulumiConfigInfo, as it contains storage account key
  console.info(
    `Executing Pulumi pipeline for environments ${organization.environments
      .map((env) => (typeof env === "string" ? env : env.name))
      .join(", ")}.`,
  );
  // For some reason, due some TS compiler bug, we must specify generic argument explicitly.
  return await pipeline.runPulumiPipeline<"up" | "preview">(
    {
      pulumi: {
        auth: pulumiConfigInfo.auth,
        backendConfig: pulumiConfigInfo.backendConfig,
        programArgs: {
          projectName: "bootstrap",
          stackName: "main",
          program: () =>
            pulumiSetup.pulumiProgram({
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
              targetResources: {
                cicdRGSuffix: "bootstrap",
                targetRGSuffix: undefined, // No target RG creation
                skipTargetRoleAssignment: true, // No "Owner" role assignment to subscription (as we already did it in bootstrap.default)
              },
            }),
        },
      },
      azure: {
        tenantId: azure.tenantId,
        // Intentionally leave out subscription ID in order to cause errors if default provider is accidentally used.
        subscriptionId: undefined,
      },
    },
    ["azure-native", "azuread", "tls"],
    doChanges ? "up" : "preview",
    eventEmitters,
  );
};

const getBootstrapAppForSetup = (
  app: BootstrapperApp,
): bootstrap.BootstrapperApp =>
  app.type === "msi"
    ? app
    : {
        ...app,
        willNeedToCreateAADApps:
          app.envSpecificPulumiPipelineSPAuth !== undefined,
      };

export type PulumiPipelineEventEmitters = pipeline.PulumiPipelineEventEmitters;
