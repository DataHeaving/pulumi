import * as automation from "@pulumi/pulumi/automation";
import { URL } from "url";

/**
 * Interface capturing all necessary configuration for creating or selecting Pulumi stack with Azure services for backend (storage account container + key vault key).
 */
export interface PulumiAzureBackendStackAcquiringConfig {
  pulumi: {
    programArgs: automation.InlineProgramArgs;
    auth: PulumiAzureBackendAuth;
    backendConfig: PulumiAzureBackendConfig;
    /**
     * By default, if this option is not supplied, the behaviour is to use return value of @see {createDefaultProcessEnvVars}
     */
    processEnvVars?: (
      envVars: Record<string, string>,
    ) => Record<string, string>;
    /**
     * By default, if this option is not supplied, the behaviour is to use @see {defaultProcessLocalWorkspaceOptions}
     */
    processLocalWorkspaceOptions?: (
      options: InitialLocalWorkspaceOptions,
    ) => automation.LocalWorkspaceOptions;
  };
  azure: AzureCloudInformationMinimal; // Minimal because subscripton ID can be left out out if working in multi-sub environment during single Pulumi pipeline, which often requires explicit provider passing to resources. This will make default "azure-native" provider fail, catching any possible typo errors.
}

/**
 * This function will get existing Pulumi stack using Azure services for backend, or create a new one.
 * @param {PulumiAzureBackendStackAcquiringConfig} parameters The parameters capturing necessary information to get or create the Pulumi stack.
 * @returns {automation.Stack} The Pulumi stack that was selected or created.
 */
export const getOrCreateStackWithAzureBackend = async (
  parameters: PulumiAzureBackendStackAcquiringConfig,
) => {
  return automation.LocalWorkspace.createOrSelectStack(
    parameters.pulumi.programArgs,
    createLocalWorkspaceOptionsForStackWithAzureBackend(parameters),
  );
};

export const createLocalWorkspaceOptionsForStackWithAzureBackend = (
  parameters: PulumiAzureBackendStackAcquiringConfig,
) => {
  const { envVars, ...settings } = getCommonLocalWorkspaceOptions(parameters);
  const { processEnvVars, processLocalWorkspaceOptions } = parameters.pulumi;
  const wsOptions = {
    ...settings,
    envVars: (processEnvVars ?? createDefaultProcessEnvVars(parameters))(
      envVars,
    ),
  };
  return (processLocalWorkspaceOptions ?? defaultProcessLocalWorkspaceOptions)(
    wsOptions,
  );
};

/**
 * Gets necessary environment variables for easily using "azure-native" Pulumi provider.
 * @param {PulumiAzureBackendStackAcquiringConfig} param0 The configuration of type PulumiStackAcquiringConfig.
 * @param {boolean|undefined} enablePulumiPartnerId Whether to enable Pulumi partner ID by leaving out `ARM_DISABLE_PULUMI_PARTNER_ID` env variable.
 * @returns {Record<string, string>} Environment variables to pass to Pulumi which are utilized by "azure-native" provider.
 */
export const getAzureProviderEnvVars = (
  {
    pulumi: { auth },
    azure: { tenantId, subscriptionId },
  }: PulumiAzureBackendStackAcquiringConfig,
  enablePulumiPartnerId?: boolean,
) => {
  // For Azure authentication used by Pulumi itself, notice the "ARM_" prefix and slightly different naming for certificate path, for more details see https://www.pulumi.com/docs/reference/pkg/azure-native/provider/#inputs
  const baseEnvVars: Record<string, string> = {
    ARM_TENANT_ID: tenantId,
  };
  if (subscriptionId) {
    baseEnvVars.ARM_SUBSCRIPTION_ID = subscriptionId;
  }
  if (enablePulumiPartnerId !== true) {
    baseEnvVars.ARM_DISABLE_PULUMI_PARTNER_ID = "true";
  }
  let authEnvVars: Record<string, string>;
  switch (auth.type) {
    case "sp":
      {
        const { clientId, pfxPath, pfxPassword } = auth;
        authEnvVars = {
          ARM_CLIENT_ID: clientId,
          ARM_CLIENT_CERTIFICATE_PATH: pfxPath,
          ARM_CLIENT_CERTIFICATE_PASSWORD: pfxPassword ?? "",
        };
      }
      break;
    case "msi":
      {
        const { clientId } = auth;
        authEnvVars = {
          ARM_CLIENT_ID: clientId,
          ARM_USE_MSI: "true",
        };
      }
      break;
    default:
      throw new Error(
        `Unsupported auth type "${(auth as PulumiAzureBackendAuth).type}".`,
      );
  }

  return Object.assign(baseEnvVars, authEnvVars);
};

/**
 * This function creates callback which will then assign result of @see {getAzureProviderEnvVars} to given environment variable dictionary.
 * @param {PulumiAzureBackendStackAcquiringConfig} parameters The configuration of type PulumiStackAcquiringConfig.
 * @returns Callback which, when called, will assign result of @see {getAzureProviderEnvVars} to given environment variable dictionary.
 */
export const createDefaultProcessEnvVars =
  (parameters: PulumiAzureBackendStackAcquiringConfig) =>
  (envVars: Record<string, string>) =>
    Object.assign(envVars, getAzureProviderEnvVars(parameters));

/**
 * Right now, this function is no-op,
 * @param opts The initial workspace options.
 * @returns Parameter `opts` unprocessed.
 */
export const defaultProcessLocalWorkspaceOptions = (
  opts: InitialLocalWorkspaceOptions,
) => opts;

// Workspace options for listing/selecting stacks - ARM_XYZ variables not included
const getCommonLocalWorkspaceOptions = ({
  pulumi: {
    auth,
    backendConfig: {
      storageAccountName,
      storageContainerName,
      encryptionKeyURL,
    },
    programArgs: { projectName, stackName },
  },
  azure: { tenantId },
}: PulumiAzureBackendStackAcquiringConfig): InitialLocalWorkspaceOptions => {
  const baseEnvVars: Record<string, string> = {
    // These two variables are required to be passed as env variables
    AZURE_STORAGE_ACCOUNT: storageAccountName,
    // For Azure authentication used when connecting to KV secrets manager, for more details see https://github.com/Azure/go-autorest/blob/master/autorest/azure/auth/auth.go#L38
    // Notice that these env variables prefix with "AZURE_" instead of "ARM_"!
    // Also notice that unlike Azure CLI, which is happy with unencrypted .pem file, we must supply .pfx file instead.
    AZURE_TENANT_ID: tenantId,
  };
  let authEnvVars: Record<string, string>;
  switch (auth.type) {
    case "sp":
      {
        const { clientId, pfxPath, pfxPassword } = auth;
        authEnvVars = {
          AZURE_CLIENT_ID: clientId,
          AZURE_CERTIFICATE_PATH: pfxPath,
          AZURE_CERTIFICATE_PASSWORD: pfxPassword ?? "",
          // Non-MSI auth requires this, for more details see https://github.com/google/go-cloud/blob/master/blob/azureblob/azureblob.go#L162
          AZURE_STORAGE_KEY: auth.backendStorageAccountKey,
        };
      }
      break;
    case "msi":
      {
        const { clientId } = auth;
        authEnvVars = {
          AZURE_CLIENT_ID: clientId,
        };
      }
      break;
    default:
      throw new Error(
        `Unsupported auth type "${(auth as PulumiAzureBackendAuth).type}".`,
      );
  }
  const parsedEncryptionKeyURL = new URL(encryptionKeyURL);
  const secretsProvider = `azurekeyvault://${parsedEncryptionKeyURL.hostname}${parsedEncryptionKeyURL.pathname}`;
  return {
    // Specify project settings, including stack-specific backend URL
    projectSettings: {
      name: projectName,
      runtime: "nodejs" as const,
      backend: {
        url: `azblob://${storageContainerName}`,
      },
    },
    envVars: Object.assign(baseEnvVars, authEnvVars),
    // Notice that we must specify secrets provider both here, and in stack settings.
    // Alternatively work-dir could be cwd(), and stackSettings modification could be left out.
    secretsProvider,
    stackSettings: {
      [stackName]: {
        secretsProvider,
      },
    },
  };
};

export type InitialLocalWorkspaceOptions = Omit<
  automation.LocalWorkspaceOptions,
  "envVars" | "secretsProvider"
> & {
  envVars: Record<string, string>;
  secretsProvider: string;
};

export interface AzureCloudInformationMandatory {
  tenantId: string;
}

export interface AzureCloudInformationOptional {
  subscriptionId: string;
}

export type AzureCloudInformationMinimal = AzureCloudInformationMandatory &
  Partial<AzureCloudInformationOptional>;

export type AzureCloudInformationFull = AzureCloudInformationMandatory &
  AzureCloudInformationOptional;

/**
 * This type captures available ways to authenticate when Pulumi backend accesses Azure:
 * @type {PulumiAuthSP}
 * @type {PulumiAuthMSI}
 */
export type PulumiAzureBackendAuth = PulumiAuthSP | PulumiAuthMSI;

/**
 * This type declares that Pulumi backend should use service principal credentials to authenticate. Only certificates are supported for now. Storage key is mandatory in this case, due to how [certain part of Go-Cloud library](https://github.com/google/go-cloud/blob/master/blob/azureblob/azureblob.go#L162) is implemented.
 */
export interface PulumiAuthSP {
  type: "sp";
  clientId: string;
  pfxPath: string;
  pfxPassword?: string;
  backendStorageAccountKey: string;
}

/**
 * This type declares that Pulumi backend should use managed service identity to authenticate. Client ID is mandatory in this case, due to how [certain part of Go-Cloud library](https://github.com/google/go-cloud/blob/master/blob/azureblob/azureblob.go#L162) is implemented.
 */
export interface PulumiAuthMSI {
  type: "msi";
  clientId: string;
}

export interface PulumiAzureBackendConfig {
  storageAccountName: string;
  storageContainerName: string;
  encryptionKeyURL: string;
}
