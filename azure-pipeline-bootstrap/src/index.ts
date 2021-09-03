import * as id from "@azure/identity";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as pipeline from "@data-heaving/pulumi-azure-pipeline";
import * as pulumiSetup from "@data-heaving/pulumi-azure-pipeline-setup";
import * as bootstrap from "./bootstrap";

export interface Inputs {
  credentials: id.TokenCredential;
  bootstrapperApp: BootstrapperAppSP | BootstrapperAppMSI;
  azure: pulumiAzure.AzureCloudInformationFull;
  organization: Organization;
  pipelineConfigs: {
    pulumiEncryptionKeyBitsForBootstrapper: number;
    pulumiEncryptionKeyBitsForEnvSpecificPipeline: number;
  };
  doChanges: boolean;
}

export type Organization = bootstrap.OrganizationInfo &
  pulumiSetup.OrganizationInfo;

export type BootstrapperApp = BootstrapperAppSP | BootstrapperAppMSI;

export type BootstrapperAppSP = Omit<
  bootstrap.BootstrapperAppSP,
  "willNeedToCreateAADApps"
> & {
  // This exists only for SP info, as MSIs are unable to do any AAD changes.
  envSpecificPulumiPipelineSPAuth?: pulumiSetup.SPCertificateInfo | undefined;
};
export type BootstrapperAppMSI = bootstrap.BootstrapperAppMSI;

/* eslint-disable no-console */
export const main = async ({
  doChanges,
  bootstrapperApp,
  organization,
  azure,
  ...input
}: Inputs) => {
  console.info("Setting up infrastructure for Pulumi...");
  const {
    cicdRGName,
    kvName,
    pulumiConfigInfo,
    envSpecificPipelineConfigReader,
  } = await bootstrap.default({
    credentials: input.credentials,
    azure,
    organization,
    pulumiEncryptionKeyBits:
      input.pipelineConfigs.pulumiEncryptionKeyBitsForBootstrapper,
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
                        containerPrefixString: "cicd-env-",
                      },
                pulumiKVInfo: {
                  rgName: cicdRGName,
                  name: kvName,
                  keyNamePrefix: "cicd-env-",
                  secretNamePrefix: "config-env-",
                  encryptionKeyBits:
                    input.pipelineConfigs
                      .pulumiEncryptionKeyBitsForEnvSpecificPipeline,
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
