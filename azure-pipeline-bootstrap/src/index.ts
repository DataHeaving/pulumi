import * as id from "@azure/identity";
import * as pulumiAutomation from "@data-heaving/pulumi-automation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as bootstrap from "./bootstrap";
import * as pulumi from "@data-heaving/pulumi-azure-pipeline-setup";

export interface Inputs {
  credentials: id.TokenCredential;
  bootstrapperApp: BootstrapperAppSP | BootstrapperAppMSI;
  azure: pulumiAzure.AzureCloudInformationFull;
  organization: bootstrap.OrganizationInfo & pulumi.OrganizationInfo;
  pipelineConfigs: {
    pulumiEncryptionKeyBitsForBootstrapper: number;
    pulumiEncryptionKeyBitsForEnvSpecificPipeline: number;
  };
  doChanges: boolean;
}

export type BootstrapperApp = BootstrapperAppSP | BootstrapperAppMSI;

export type BootstrapperAppSP = Omit<
  bootstrap.BootstrapperAppSP,
  "willNeedToCreateAADApps"
> & {
  // This exists only for SP info, as MSIs are unable to do any AAD changes.
  envSpecificPulumiPipelineSPAuth?: pulumi.SPCertificateInfo | undefined;
};
export type BootstrapperAppMSI = bootstrap.BootstrapperAppMSI;

/* eslint-disable no-console */
export const main = async ({
  doChanges,
  bootstrapperApp,
  ...input
}: Inputs) => {
  console.info("Setting up infrastructure for Pulumi...");
  const {
    cicdRGName,
    kvName,
    pulumiConfigInfo,
    envSpecificPipelineConfigReader,
  } = await bootstrap.default({
    ...input,
    pulumiEncryptionKeyBits:
      input.pipelineConfigs.pulumiEncryptionKeyBitsForBootstrapper,
    bootstrapperApp: getBootstrapAppForSetup(bootstrapperApp),
  });
  console.info("Done."); // Don't print pulumiConfigInfo, as it contains storage account key
  console.info("Acquiring Pulumi stack...");
  const stack = await pulumiAzure.getOrCreateStackWithAzureBackend({
    pulumi: {
      auth: pulumiConfigInfo.auth,
      backendConfig: pulumiConfigInfo.backendConfig,
      programArgs: {
        projectName: "bootstrap",
        stackName: "main",
        program: () =>
          pulumi.pulumiProgram({
            organization: input.organization,
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
                      containerPrefixString: "cicd-site-",
                    },
              pulumiKVInfo: {
                rgName: cicdRGName,
                name: kvName,
                keyNamePrefix: "cicd-site-",
                secretNamePrefix: "config-site-",
                encryptionKeyBits:
                  input.pipelineConfigs
                    .pulumiEncryptionKeyBitsForEnvSpecificPipeline,
              },
            },
            targetResources: {
              cicdRGSuffix: "bootstrap",
              targetRGSuffix: undefined, // No target RG creation
              //skipTargetRoleAssignment: true, // No "Owner" role assignment to subscription (as we already did it in bootstrap.default)
            },
          }),
      },
    },
    azure: {
      tenantId: input.azure.tenantId,
      // Intentionally leave out subscription ID in order to cause errors if default provider is used.
      subscriptionId: undefined,
    },
  });
  console.info("Done.");
  console.info(
    "Handling changes of resources for environments...",
    input.organization.environments.map(({ name }) => name),
  );
  await pulumiAutomation.initPulumiExecution(
    pulumiAutomation.consoleLoggingEventEmitterBuilder().createEventEmitter(),
    stack,
    ["azure-native", "azuread", "tls"],
  );
  if (doChanges) {
    console.info("Performing infrastructure changes...");
    const result = await stack.up({ onOutput: console.info, diff: true });
    console.log(
      `update summary: \n${JSON.stringify(
        result.summary.resourceChanges,
        null,
        4,
      )}`,
    );
    console.info("Done.");
  } else {
    console.info("Previewing infrastructure changes...");
    const result = await stack.preview({
      onOutput: console.info,
      diff: true,
    });
    console.log(
      `change summary: \n${JSON.stringify(result.changeSummary, null, 4)}`,
    );
  }
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
