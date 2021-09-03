import * as tls from "@pulumi/tls";

export type OrganizationInfo = {
  name: string;
  /**
   * Fallback location if not specified in environment
   */
  location?: string;
  environments: ReadonlyArray<OrganizationEnvironment>;
};

export interface OrganizationEnvironment {
  /**
   * The `environments` array of @type {OrganizationInfo} will be deduplicated case-insensitively by this property.
   * If any duplicates are noticed, an error will be raised.
   */
  name: string;
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
  /**
   * Suffix of RG holding CICD resources (storage acco, etc).
   */
  cicdRGSuffix: string;
  /**
   * If this is undefined, the Owner role assignment target is subscription.
   * If this is empty string, then the target is cicd RG.
   */
  targetRGSuffix?: string;

  /**
   * If this is set to true, the "Owner" role assignment to target sub/RG is skipped.
   */
  skipTargetRoleAssignment?: boolean;
}
