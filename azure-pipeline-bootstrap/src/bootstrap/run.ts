import "cross-fetch";
import "cross-fetch/polyfill";
import * as graph from "@microsoft/microsoft-graph-client";
import * as id from "@azure/identity";
import * as common from "@data-heaving/common";
import * as pulumi from "@data-heaving/pulumi-azure-pipeline-setup";
import * as fs from "fs/promises";
import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as types from "./types";
import * as events from "./events";
import * as ad from "./run-ad";
import * as auth from "./run-auth";
import * as pulumiSetup from "./run-pulumi";
import * as certs from "./run-certs";

export interface Inputs {
  eventEmitter: events.BootstrapEventEmitter;
  credentials: types.BootstrappingCredentials;
  bootstrapperApp: BootstrapperAppSP | BootstrapperAppMSI;
  azure: pulumiAzure.AzureCloudInformationFull;
  organization: pulumiSetup.OrganizationInfo;
  pulumiEncryptionKeyBits: number;
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
  willNeedToCreateAADApps: boolean;
}

export interface BootstrapperAppMSI {
  type: "msi";
  clientId: string;
  principalId: string;
}

export const performBootstrap = async (inputs: Inputs) => {
  const bootstrapperInfo = await setupBootstrapperApp(inputs);
  const { backendConfig, backendStorageAccountKey, cicdRGName, kvName } =
    await runWithBootstrapper(inputs, bootstrapperInfo);
  const { bootstrapperPulumiAuth } = bootstrapperInfo;
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
  };
};

const setupBootstrapperApp = async ({
  eventEmitter,
  credentials,
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
          principalType: "MSI",
        }
      : {
          principalId: await getCurrentPrincipalId(graphClient),
          principalType: "User", // TODO how to get this meaningfully via Graph API, or should use some other trick? Maybe examine type of credentials via instanceof ? Only possible way for that to be user is if they are Cli/Device credentials. I guess "ServicePrincipal" is another possibility here?
        };
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
        const { keyPEM, keyAndCertPath } =
          await certs.ensureCertificateCredentialsFileExists(
            spAuth.tempDir,
            keyPath,
            certPEM,
          );
        spAuthStorageConfig = {
          keyPEM,
          certPEM,
          configReaderPrincipalId: envSpecificPipelineConfigReader.principalId,
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
          (bootstrapperApp as BootstrapperAppSP | BootstrapperAppMSI).type
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
    spAuthStorageConfig,
    envSpecificPipelineConfigReader,
  };
};

const runWithBootstrapper = async (
  { eventEmitter, azure, organization, pulumiEncryptionKeyBits }: Inputs,
  {
    bootstrapperCredentials,
    principalId,
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
  });
};

const graphSelf = t.type(
  {
    // ["@odata.context"]: t.literal(
    //   "https://graph.microsoft.com/v1.0/$metadata#users/$entity"
    // ),
    // ["@odata.id"]: validation.urlWithPath,
    // businessPhones: [],
    // displayName: validation.nonEmptyString,
    // givenName: validation.nonEmptyString,
    // jobTitle: null,
    // mail: null,
    // mobilePhone: null,
    // officeLocation: null,
    // preferredLanguage: validation.nonEmptyString,
    // surname: validation.nonEmptyString,
    // userPrincipalName: validation.nonEmptyString,
    id: validation.uuid,
  },
  "GraphUser",
);

const getCurrentPrincipalId = async (graphClient: graph.Client) =>
  validation.decodeOrThrow(graphSelf.decode, await graphClient.api("/me").get())
    .id;

export const constructVaultName = pulumiSetup.constructVaultName;
export const constructBootstrapperAppAuthSecretName =
  pulumiSetup.constructBootstrapperAppAuthSecretName;
export const tryGetSecretValue = pulumiSetup.tryGetSecretValue;
export const BEGIN_CERTIFICATE = certs.BEGIN_CERTIFICATE;
