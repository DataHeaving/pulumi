import * as pulumi from "@pulumi/pulumi";
import * as azureProvider from "@pulumi/azure-native/provider";
import * as arm from "./resources-arm";
import * as ad from "./resources-ad";
import * as utils from "@data-heaving/common";
import * as types from "./types";

export interface Inputs {
  organization: types.OrganizationInfo;
  pulumiPipelineConfig: PulumiPipelineConfig;
  envSpecificPipelineConfigReader: types.EnvSpecificPipelineConfigReader;
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
  { name: envName, subscriptionId, location }: types.OrganizationEnvironment,
) => {
  const { auth, ...pulumiPipelineConfig } = inputs.pulumiPipelineConfig;
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

export type PulumiPipelineConfig =
  types.PulumiPipelineConfig<PulumiPipelineAuthInfo>;

export type PulumiPipelineAuthInfo =
  | PulumiPipelineAuthInfoMSI
  | PulumiPipelineAuthInfoSP;

type PulumiPipelineAuthInfoMSI = arm.PulumiPipelineAuthInfoMSI;
type PulumiPipelineAuthInfoSP = {
  type: "sp";
  certificateConfig: ad.SPCertificateInfo;
};

export type SPCertificateInfo = ad.SPCertificateInfo;

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
