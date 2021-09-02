import * as tls from "@pulumi/tls";

export type OrganizationInfo = {
  name: string;
  location?: string;
  environments: ReadonlyArray<OrganizationEnvironment>;
};

export interface OrganizationEnvironment {
  name: string; // Array will be deduplicated case-insensitively by this property
  subscriptionId: string;
  location?: string;
}

export interface EnvSpecificPipelineConfigReader {
  principalId: string;
  principalType: string;
}

export interface PulumiPipelineConfig<TAuth> {
  pulumiKVInfo: PulumiKeyVaultInfo;
  auth: TAuth;
}

export interface PulumiKeyVaultInfo {
  rgName: string;
  name: string;
  keyNamePrefix: string;
  secretNamePrefix: string;
  encryptionKeyBits: number;
}

export interface SPCertificateInfo {
  rsaBits: number;
  validityHours: number;
  subject: tls.types.input.SelfSignedCertSubject;
}

export interface TargetResourcesConfig {
  cicdRGSuffix: string;
  targetRGSuffix: string | undefined; // undefined = target is subscription, empty string = same as cicdRGSuffix
}
