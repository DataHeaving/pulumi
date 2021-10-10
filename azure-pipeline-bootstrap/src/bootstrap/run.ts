import "cross-fetch";
import "cross-fetch/polyfill";
import * as graph from "@microsoft/microsoft-graph-client";
import * as id from "@azure/identity";
import * as common from "@data-heaving/common";
import * as pulumi from "@data-heaving/pulumi-azure-pipeline-setup";
import * as fs from "fs/promises";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as pipelineConfig from "@data-heaving/pulumi-azure-pipeline-config";
import * as types from "./types";
import * as events from "./events";
import * as ad from "./run-ad";
import * as auth from "./run-auth";
import * as pulumiSetup from "./run-pulumi";
import * as certs from "./run-certs";

export interface Inputs {
  eventEmitter: events.BootstrapEventEmitter;
  credentials: types.BootstrappingCredentials;
  bootstrapperApp: BootstrapperApp;
  azure: pulumiAzure.AzureCloudInformationFull;
  organization: pulumiSetup.OrganizationInfo;
  pulumiEncryptionKeyBits: number;
  bootstrapperPipelineConfigSecretName: string | undefined;
}

export interface Outputs {
  cicdRGName: string;
  kvName: string;
  pulumiConfigInfo: {
    backendConfig: pulumiAzure.PulumiAzureBackendConfig;
    auth: pulumiAzure.PulumiAzureBackendAuth;
  };
  envSpecificPipelineConfigReader: pulumi.EnvSpecificPipelineConfigReader;
  bootstrapAuth: pipelineConfig.PipelineConfigAuth;
  keyAndCertPath: string;
}

export type BootstrapperApp = BootstrapperAppSP | BootstrapperAppMSI;

export type OrganizationInfo = pulumiSetup.OrganizationInfo;

export interface BootstrapperAppSP {
  type: "sp";
  displayName: string;
  authentication: {
    rsaBits: number;
    tempDir: string;
    keyPath: string;
    certPath: string;
    certValidityPeriodDays: number;
    certSubject: string;
    pfxPath: string;
    pfxPassword: string;
  };
  appRequiredPermissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>;
  configSecretName: string;
}

export interface BootstrapperAppMSI {
  type: "msi";
  clientId: string;
  principalId: string;
  resourceId: string;
}

export const performBootstrap = async (inputs: Inputs): Promise<Outputs> => {
  const bootstrapperInfo = await setupBootstrapperApp(inputs);
  const {
    backendConfig,
    backendStorageAccountKey,
    cicdRGName,
    kvName,
    bootstrapAuth,
  } = await runWithBootstrapper(inputs, bootstrapperInfo);
  const { bootstrapperPulumiAuth, keyAndCertPath } = bootstrapperInfo;
  if (bootstrapperPulumiAuth.type === "sp") {
    bootstrapperPulumiAuth.backendStorageAccountKey = backendStorageAccountKey;
  }
  return {
    cicdRGName,
    kvName,
    pulumiConfigInfo: {
      backendConfig,
      auth: bootstrapperPulumiAuth,
    },
    envSpecificPipelineConfigReader:
      bootstrapperInfo.envSpecificPipelineConfigReader,
    bootstrapAuth,
    keyAndCertPath,
  };
};

const setupBootstrapperApp = async ({
  eventEmitter,
  credentials: { credentials, givenClientId },
  bootstrapperApp,
  azure: { tenantId, subscriptionId },
}: Inputs) => {
  // 1. Ensure bootstrap SP is created using current Azure CLI credentials
  let clientId: string;
  let principalId: string;
  let bootstrapperCredentials: id.TokenCredential;
  let bootstrapperPulumiAuth: pulumiAzure.PulumiAzureBackendAuth;
  let spAuthStorageConfig: pulumiSetup.SPAuthStorageConfig | undefined;
  const graphClient = graph.Client.initWithMiddleware({
    authProvider: credentials,
    debugLogging: true, // This will print URL of every command
  });
  const envSpecificPipelineConfigReader: pulumi.EnvSpecificPipelineConfigReader =
    bootstrapperApp.type === "msi"
      ? {
          principalId: bootstrapperApp.principalId,
          principalType: "ServicePrincipal", // It appears that in Azure role assignments, even MSIs will get this principal type instead of "MSI",
        }
      : await ad.getCurrentPrincipalInfo(graphClient, givenClientId);
  eventEmitter.emit(
    "afterResolvingConfigReaderPrincipal",
    common.deepCopy(envSpecificPipelineConfigReader),
  );
  let msiResourceID = "";
  let keyAndCertPath = "";
  switch (bootstrapperApp.type) {
    case "sp":
      {
        const { keyPath, certPath, rsaBits, pfxPath, pfxPassword, ...spAuth } =
          bootstrapperApp.authentication;
        await certs.ensureKeyAndCertExists(
          keyPath,
          certPath,
          rsaBits,
          spAuth.certValidityPeriodDays,
          spAuth.certSubject,
        );
        const certPEM = certs.ensureEndsWithNewline(
          await fs.readFile(certPath, "utf-8"),
        );
        const clientAndPrincipalID = await ad.ensureBootstrapSPIsConfigured({
          eventEmitter,
          graphClient,
          bootstrapperApp,
          certificatePEM: certPEM,
        });
        ({ clientId, principalId } = clientAndPrincipalID);
        let keyPEM: string;
        ({ keyPEM, keyAndCertPath } =
          await certs.ensureCertificateCredentialsFileExists(
            spAuth.tempDir,
            keyPath,
            certPEM,
          ));
        spAuthStorageConfig = {
          keyPEM,
          certPEM,
          configReaderPrincipalId: envSpecificPipelineConfigReader.principalId,
          configSecretName: bootstrapperApp.configSecretName,
        };
        bootstrapperCredentials = new id.ClientCertificateCredential(
          tenantId,
          clientId,
          keyAndCertPath,
        );
        await certs.ensurePfxExists(keyPath, certPath, pfxPath, pfxPassword);
        bootstrapperPulumiAuth = {
          type: "sp",
          clientId,
          pfxPath,
          pfxPassword,
          backendStorageAccountKey: "", // Will be modified by performSetUp
        };
      }
      break;
    case "msi":
      {
        ({ clientId, principalId } = bootstrapperApp);
        msiResourceID = bootstrapperApp.resourceId;
        bootstrapperCredentials = new id.ManagedIdentityCredential(clientId);
        bootstrapperPulumiAuth = {
          type: "msi",
          clientId,
        };
      }
      break;
    default:
      throw new Error(
        `Unrecognized bootstrapper app kind: "${
          (bootstrapperApp as BootstrapperApp).type
        }"`,
      );
  }

  // 2. Ensure bootstrap SP has enough permissions to continue operating
  await auth.ensureBootstrapSPHasEnoughPrivileges({
    eventEmitter,
    credentials,
    principalId,
    subscriptionId,
  });

  return {
    bootstrapperCredentials,
    bootstrapperPulumiAuth,
    principalId,
    clientId,
    msiResourceID,
    keyAndCertPath,
    spAuthStorageConfig,
    envSpecificPipelineConfigReader,
  };
};

const runWithBootstrapper = async (
  {
    eventEmitter,
    azure,
    organization,
    pulumiEncryptionKeyBits,
    bootstrapperPipelineConfigSecretName,
  }: Inputs,
  {
    bootstrapperCredentials,
    principalId,
    clientId,
    msiResourceID,
    spAuthStorageConfig,
  }: common.DePromisify<ReturnType<typeof setupBootstrapperApp>>,
) => {
  // 4. Create credentials for bootstrap SP, and then create necessary resources for Pulumi state management using bootstrap SP
  return await pulumiSetup.ensureRequireCloudResourcesForPulumiStateExist({
    eventEmitter,
    credentials: bootstrapperCredentials,
    azure,
    organization,
    principalId,
    spAuthStorageConfig,
    pulumiEncryptionKeyBits,
    storeBootstrapPipelineConfigToKV: {
      secretName: bootstrapperPipelineConfigSecretName,
      clientId,
      resourceId: msiResourceID,
    },
  });
};

export const constructVaultName = pulumiSetup.constructVaultName;
export const tryGetSecretValue = pulumiSetup.tryGetSecretValue;
export const BEGIN_CERTIFICATE = certs.BEGIN_CERTIFICATE;
