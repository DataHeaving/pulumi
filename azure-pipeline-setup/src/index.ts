import * as pulumi from "@pulumi/pulumi";
import * as azureProvider from "@pulumi/azure-native/provider";
import * as arm from "./resources-arm";
import * as ad from "./resources-ad";
import * as utils from "@data-heaving/common";
import * as types from "./types";

export * from "./types";

export interface Inputs {
  organization: types.OrganizationInfo;
  pulumiPipelineConfig: PulumiPipelineConfig;
  envSpecificPipelineConfigReader: types.EnvSpecificPipelineConfigReader;
  targetResources: types.TargetResourcesConfig;
}

/**
 * Key: env name.
 * Value: env-specific setup information.
 */
export type Outputs = Record<string, EnvironmentSetupOutput>;

export interface EnvironmentSetupOutput {
  configSecretURI: pulumi.Output<string>;
}

export const pulumiProgram = async (inputs: Inputs): Promise<Outputs> => {
  const envs = utils.deduplicate(inputs.organization.environments, ({ name }) =>
    name.toLowerCase(),
  );
  if (envs.length !== inputs.organization.environments.length) {
    throw new Error(
      "Environments contained duplicated items, please check the configuration!",
    );
  }
  return (
    await Promise.all(
      envs.map((envConfig) => createResourcesForSingleEnv(inputs, envConfig)),
    )
  ).reduce<Outputs>((perEnvOutputs, currentOutput, idx) => {
    const { name } = envs[idx];
    perEnvOutputs[name] = {
      configSecretURI: currentOutput.armInfo.pipelineConfigSecretURI,
    };
    return perEnvOutputs;
  }, {});
};

const createResourcesForSingleEnv = async (
  inputs: Omit<Inputs, "environments">,
  {
    name: envName,
    subscriptionId,
    location,
    envSpecificAuthOverride,
  }: types.OrganizationEnvironment,
) => {
  const { auth: defaultAuth, ...pulumiPipelineConfig } =
    inputs.pulumiPipelineConfig;
  const auth = constructEnvSpecificAuth(
    envName,
    defaultAuth,
    envSpecificAuthOverride,
  );
  const envInputs = { ...inputs, envName };
  const { name: orgName } = inputs.organization;
  let authInfo: AuthInfoSP | AuthInfoMSI | undefined = undefined;
  let pulumiPipelineAuthInfoArm:
    | arm.PulumiPipelineAuthInfoMSI
    | arm.PulumiPipelineAuthInfoSP;
  if (auth.type === "msi") {
    pulumiPipelineAuthInfoArm = auth;
  } else {
    const adResult = await ad.default({
      envName,
      organization: orgName,
      certificateConfig: auth.certificateConfig,
      requiredResourceAccesses: auth.applicationRequiredResourceAccess ?? [],
    });
    const { sp } = adResult;
    authInfo = {
      type: "sp",
      keyPEM: adResult.key.privateKeyPem,
      certPEM: adResult.cert.certPem,
      clientId: sp.applicationId,
    };
    pulumiPipelineAuthInfoArm = {
      type: "sp" as const,
      principalId: sp.id,
      clientId: sp.applicationId,
      keyPEM: authInfo.keyPEM,
      certPEM: authInfo.certPEM,
    };
  }
  const envLocation = location ?? inputs.organization.location;
  if (!envLocation) {
    throw new Error(
      `The location for environment "${envName}" must be specified either within environment info or on a scope of whole config.`,
    );
  }
  const armInfo = await arm.default({
    ...envInputs,
    organization: {
      name: orgName,
      location: envLocation,
    },
    pulumiPipelineConfig: {
      ...pulumiPipelineConfig,
      auth: pulumiPipelineAuthInfoArm,
    },
    pulumiOpts: {
      provider: new azureProvider.Provider(envName, {
        subscriptionId,
      }),
    },
  });
  if (!authInfo) {
    authInfo = {
      type: "msi",
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      resourceID: armInfo.msiResource!.id,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      clientId: armInfo.msiResource!.clientId,
    };
  }
  return {
    armInfo,
    authInfo,
  };
};

export default pulumiProgram;

const constructEnvSpecificAuth = (
  envName: string,
  defaultAuth: types.PulumiPipelineAuthInfo,
  envAuth: Partial<types.PulumiPipelineAuthInfo> | undefined,
): types.PulumiPipelineAuthInfo => {
  if (envAuth === undefined) {
    return defaultAuth;
  } else {
    if (envAuth.type === undefined || envAuth.type === defaultAuth.type) {
      return Object.assign({}, defaultAuth, envAuth);
    } else {
      switch (envAuth.type) {
        case "msi":
          return {
            type: "msi",
            sharedSARGName:
              envAuth.sharedSARGName ?? doThrow(envName, "sharedSARGName"),
            sharedSAName:
              envAuth.sharedSAName ?? doThrow(envName, "sharedSAName"),
            containerPrefixString:
              envAuth.containerPrefixString ??
              doThrow(envName, "containerPrefixString"),
          };
        case "sp":
          return {
            type: "sp",
            certificateConfig:
              envAuth.certificateConfig ??
              doThrow(envName, "certificateConfig"),
            applicationRequiredResourceAccess:
              envAuth.applicationRequiredResourceAccess,
          };
      }
    }
  }
};

const doThrow = <T>(envName: string, propName: string): T => {
  throw new Error(
    `When specifying different authentication type for environment "${envName}", authentication object must have all necessary properties (including "${propName}".)`,
  );
};

export type PulumiPipelineConfig =
  types.PulumiPipelineConfig<types.PulumiPipelineAuthInfo>;

interface AuthInfoSP {
  type: "sp";
  keyPEM: pulumi.Output<string>;
  certPEM: pulumi.Output<string>;
  clientId: pulumi.Output<string>;
}

interface AuthInfoMSI {
  type: "msi";
  resourceID: pulumi.Output<string>;
  clientId: pulumi.Output<string>;
}
