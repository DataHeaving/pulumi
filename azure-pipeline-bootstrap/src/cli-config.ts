import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";

export const booleanString = t.refinement(
  t.string,
  (str) => ["true", "false"].indexOf(str.toLowerCase()) >= 0,
);

// The way to do initial authentication, in given order
export const authenticationKinds = t.array(
  t.union(
    [t.literal("device"), t.literal("env"), t.literal("cli"), t.literal("msi")],
    "AuthenticationKind",
  ),
  "AuthenticationKindList",
);

const pipelineEncryptionKeyBits = t.union(
  [t.number, t.null],
  "PulumiPipelineConfig",
);

export type PulumiPipelineEncryptionKeyBits = t.TypeOf<
  typeof pipelineEncryptionKeyBits
>;

const organization = t.type(
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
  "OrganizationConfig",
);
export type Organization = t.TypeOf<typeof organization>;

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
        azure: t.type(
          {
            tenantId: validation.uuid,
            subscriptionId: validation.uuid,
          },
          "AzureConfig",
        ),
      },
      "BootstrapConfigMandatory",
    ),
    t.partial(
      {
        pulumi: t.partial({
          pulumiEncryptionKeyBitsForBootstrapper: pipelineEncryptionKeyBits,
          pulumiEncryptionKeyBitsForEnvSpecificPipeline:
            pipelineEncryptionKeyBits,
        }),
      },
      "BootstrapConfigOptional",
    ),
  ],
  "BootstrapConfig",
);

export type Config = t.TypeOf<typeof config>;
