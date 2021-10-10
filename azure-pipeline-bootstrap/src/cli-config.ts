import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as pipeline from "./bootstrap";

export const booleanString = t.refinement(
  t.string,
  (str) => ["true", "false"].indexOf(str.toLowerCase()) >= 0,
);

// The way to do initial authentication, in given order
export const authenticationKind = t.union(
  [t.literal("device"), t.literal("env"), t.literal("cli"), t.literal("msi")],
  "AuthenticationKind",
);
export type AuthenticationKind = t.TypeOf<typeof authenticationKind>;
export const authenticationKinds = t.array(
  authenticationKind,
  "AuthenticationKindList",
);

const pipelineEncryptionKeyBits = t.union(
  [t.number, t.null],
  "PulumiPipelineConfig",
);

export type PulumiPipelineEncryptionKeyBits = t.TypeOf<
  typeof pipelineEncryptionKeyBits
>;

const providerRegistrations = t.array(
  validation.nonEmptyString,
  "ProviderRegistrationList",
);

export const organization = t.intersection(
  [
    t.type(
      {
        name: validation.nonEmptyString,
        location: validation.nonEmptyString,
        environments: t.array(
          t.union(
            [
              t.string,
              t.intersection(
                [
                  t.type(
                    {
                      name: t.string,
                    },
                    "EnvironmentInfoMandatory",
                  ),
                  t.partial(
                    {
                      location: validation.nonEmptyString,
                      subscriptionId: validation.uuid,
                      envSpecificSPAuthOverride: t.partial(
                        {
                          applicationRequiredResourceAccess: t.array(
                            pipeline.applicationRequiredResourceAccess,
                          ),
                        },
                        "EnvSpecifcSPAuthOverride",
                      ),
                      providerRegistrations: t.union(
                        [
                          providerRegistrations,
                          t.type(
                            {
                              ignoreDefaultProviderRegistrations: t.boolean,
                              providerRegistrations,
                            },
                            "EnvironmentProviderRegistrationOverride",
                          ),
                        ],
                        "EnvironmentProviderRegistrations",
                      ),
                    },
                    "EnvironmentInfoOptional",
                  ),
                ],
                "EnvironmentInfo",
              ),
            ],
            "EnvironmentConfig",
          ),
          "EnvironmentConfigList",
        ),
      },
      "OrganizationConfigMandatory",
    ),
    t.partial(
      {
        defaultProviderRegistrations: providerRegistrations,
      },
      "OrganizationConfigOptional",
    ),
  ],
  "OrganizationConfig",
);
export type Organization = t.TypeOf<typeof organization>;

export const azure = t.type(
  {
    tenantId: validation.uuid,
    subscriptionId: validation.uuid,
  },
  "AzureConfig",
);

export type AzureConfiguration = t.TypeOf<typeof azure>;

export const config = t.intersection(
  [
    t.type(
      {
        bootstrapperApp: t.union(
          [
            t.type(
              {
                type: t.literal("msi"),
                clientId: validation.uuid,
                principalId: validation.uuid,
                resourceId: validation.nonEmptyString,
              },
              "BootstrapperAppMSIConfig",
            ),
            t.intersection(
              [
                t.type(
                  {
                    type: t.literal("sp"),
                    displayName: validation.nonEmptyString,
                    authentication: t.intersection(
                      [
                        t.type(
                          {
                            certSubject: validation.nonEmptyString,
                          },
                          "BootstrapperAppSPAuthenticationConfigMandatory",
                        ),
                        t.partial(
                          {
                            rsaBits: t.Integer,
                            certValidityPeriodDays: t.Integer,
                            pfxPasswordEnvName: validation.nonEmptyString,
                          },
                          "BootstrapperAppSPAuthenticationConfigOptional",
                        ),
                      ],
                      "BootstrapperAppSPAuthenticationConfig",
                    ),
                  },
                  "BootstrapperAppSPConfigMandatory",
                ),
                t.partial(
                  {
                    envSpecificPulumiPipelineSPAuth: t.intersection(
                      [
                        t.type(
                          {
                            subject: t.partial(
                              {
                                commonName: validation.nonEmptyString,
                                country: validation.nonEmptyString,
                                locality: validation.nonEmptyString,
                                organization: validation.nonEmptyString,
                                organizationalUnit: validation.nonEmptyString,
                                postalCode: validation.nonEmptyString,
                                province: validation.nonEmptyString,
                                serialNumber: validation.nonEmptyString,
                                streetAddresses: t.array(
                                  validation.nonEmptyString,
                                ),
                              },
                              "EnvSpecificPulumiPipelinesSPAuthCertSubject",
                            ),
                          },
                          "EnvSpecificPulumiPipelinesSPAuthMandatory",
                        ),
                        t.partial(
                          {
                            rsaBits: t.Integer,
                            validityHours: t.Integer,
                          },
                          "EnvSpecificPulumiPipelinesSPAuthOptional",
                        ),
                      ],
                      "EnvSpecificPulumiPipelinesSPAuth",
                    ),
                    configSecretName: t.string,
                  },
                  "BootstrapperAppSPConfigOptional",
                ),
              ],
              "BootstrapperAppSPConfig",
            ),
          ],
          "BootstrapperAppConfig",
        ),
        organization,
        azure,
        // This is same as TargetResourcesConfig interface in azure-pipeline-setup package
        targetResources: t.intersection(
          [
            t.type(
              {
                cicdRGSuffix: validation.nonEmptyString,
              },
              "BootstrapTargetResourcesMandatory",
            ),
            t.partial(
              {
                targetRGSuffix: t.string,
                skipTargetRoleAssignment: t.boolean,
              },
              "BootstrapTargetResourcesOptional",
            ),
          ],
          "BootstrapTargetResources",
        ),
      },
      "BootstrapConfigMandatory",
    ),
    t.partial(
      {
        pulumi: t.partial(
          {
            pulumiEncryptionKeyBitsForBootstrapper: pipelineEncryptionKeyBits,
            pulumiEncryptionKeyBitsForEnvSpecificPipeline:
              pipelineEncryptionKeyBits,
          },
          "PulumiBootstrapConfigOptional",
        ),
        namingConventions: t.partial(
          {
            storageContainerPrefixString: t.string,
            keyNamePrefix: t.string,
            secretNamePrefix: t.string,
          },
          "NamingConventionsConfigOptional",
        ),
        logSubscriptionIdToConsole: t.boolean,
        bootstrapperPipelineConfigSecretName: validation.nonEmptyString,
      },
      "BootstrapConfigOptional",
    ),
  ],
  "BootstrapConfig",
);

export type Config = t.TypeOf<typeof config>;
