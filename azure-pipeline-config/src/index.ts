import * as pulumiAzure from "@data-heaving/pulumi-azure";

/**
 * This type describes the contents of the data stored by `@data-heaving/azure-pipeline-setup` package to key vault.
 */
export interface PipelineConfig {
  backend: pulumiAzure.PulumiAzureBackendConfig;
  azure: pulumiAzure.AzureCloudInformationFull;
  auth: PipelineConfigAuth;
}

export type PipelineConfigAuth = PipelineConfigMSIAuth | PipelineConfigSPAuth;

export interface PipelineConfigMSIAuth {
  type: "msi";
  clientId: string;
  resourceId: string;
}

export interface PipelineConfigSPAuth {
  type: "sp";
  clientId: string;
  keyPEM: string;
  certPEM: string;
  storageAccountKey: string;
}
