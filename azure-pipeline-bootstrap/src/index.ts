import "cross-fetch/polyfill";
import * as graph from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import * as id from "@azure/identity";
import * as utils from "@data-heaving/common";
import * as fs from "fs/promises";
import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as ad from "./ad";
import * as auth from "./auth";
import * as pulumiSetup from "./pulumi";
import * as certs from "./certs";
import * as pulumi from "../pulumi";

export interface Inputs {
  credentials: id.TokenCredential;
  bootstrapperApp: BootstrapperAppSP | BootstrapperAppMSI;
  azure: pulumiAzure.AzureCloudInformationFull;
  organization: pulumiSetup.OrganizationInfo;
  bootstrapperPipelineConfig: pulumiSetup.PulumiPipelineConfig;
}

export type BootstrapperApp = BootstrapperAppSP | BootstrapperAppMSI;

export type PulumiPipelineConfig = pulumiSetup.PulumiPipelineConfig;

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

const performSetUp = async (inputs: Inputs) => {
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
    authProvider: new TokenCredentialAuthenticationProvider(credentials, {
      scopes: ["https://graph.microsoft.com"],
    }),
  });
  const envSpecificPipelineConfigReader: pulumi.EnvSpecificPipelineConfigReader =
    {
      principalId: await getCurrentPrincipalId(graphClient),
      principalType: "User", // TODO how to get this meaningfully via Graph API, or should use some other trick? Maybe examine type of credentials via instanceof ? Only possible way for that to be user is if they are Cli/Device credentials
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
        const { ...clientAndPrincipalID } =
          await ad.ensureBootstrapSPIsConfigured({
            credentials,
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
  { azure, organization, bootstrapperPipelineConfig }: Inputs,
  {
    bootstrapperCredentials,
    principalId,
    spAuthStorageConfig,
  }: utils.DePromisify<ReturnType<typeof setupBootstrapperApp>>,
) => {
  // 4. Create credentials for bootstrap SP, and then create necessary resources for Pulumi state management using bootstrap SP
  return await pulumiSetup.ensureRequireCloudResourcesForPulumiStateExist({
    credentials: bootstrapperCredentials,
    azure,
    organization,
    principalId,
    spAuthStorageConfig,
    bootstrapperPipelineConfig,
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

export default performSetUp;

export const constructVaultName = pulumiSetup.constructVaultName;
export const constructBootstrapperAppAuthSecretName =
  pulumiSetup.constructBootstrapperAppAuthSecretName;
export const tryGetSecretValue = pulumiSetup.tryGetSecretValue;
export const BEGIN_CERTIFICATE = certs.BEGIN_CERTIFICATE;
