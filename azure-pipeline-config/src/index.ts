import * as pulumiAzure from "@data-heaving/pulumi-azure";

// The secret contents for env-specific pipeline config will contain JSON-stringified objects of this type
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
