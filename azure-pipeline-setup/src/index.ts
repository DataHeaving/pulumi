import * as pulumi from "@pulumi/pulumi";
import * as azureProvider from "@pulumi/azure-native/provider";
import * as arm from "./resources-arm";
import * as ad from "./resources-ad";
import * as utils from "@data-heaving/common";

export type Inputs = {
  organization: OrganizationInfo;
  pulumiPipelineConfig: {
    auth: PulumiPipelineAuthInfoMSI | PulumiPipelineAuthInfoSP;
    encryptionKeyBits: number;
  };
} & Omit<
  arm.Inputs,
  | "envName"
  | "principalId"
  | "pulumiPipelineAuthInfo"
  | "organization"
  | "pulumiOpts"
  | "pulumiPipelineConfig"
> &
  Omit<ad.Inputs, "envName" | "certificateConfig" | "organization">;

export type OrganizationInfo = utils.MakeOptional<
  arm.OrganizationInfo,
  "location"
> &
  OrganizationEnvironments;

export interface OrganizationEnvironments {
  environments: ReadonlyArray<{
    name: string; // Array will be deduplicated case-insensitively by this property
    subscriptionId: string;
    location?: string;
  }>;
}
export type Outputs = {
  authInfo: AuthInfoSP | AuthInfoMSI;
};

export interface AuthInfoSP {
  type: "sp";
  keyPEM: pulumi.Output<string>;
  certPEM: pulumi.Output<string>;
  clientId: pulumi.Output<string>;
}

export interface AuthInfoMSI {
  type: "msi";
  resourceID: pulumi.Output<string>;
  clientId: pulumi.Output<string>;
}

export type SPCertificateInfo = ad.SPCertificateInfo;

export type EnvSpecificPipelineConfigReader =
  arm.EnvSpecificPipelineConfigReader;

export type PulumiPipeline = arm.PulumiPipeline;

type PulumiPipelineAuthInfoMSI = arm.PulumiPipelineAuthInfoMSI;
type PulumiPipelineAuthInfoSP = Omit<
  arm.PulumiPipelineAuthInfoSP,
  "principalId" | "clientId" | "keyPEM" | "certPEM"
> & {
  certificateConfig: ad.SPCertificateInfo;
};
export const pulumiProgram = async (inputs: Inputs) => {
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
  ).reduce<Record<string, unknown>>((perEnvOutputs, currentOutput, idx) => {
    // TODO put to KV
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
  }: OrganizationInfo["environments"][number],
) => {
  const { auth } = inputs.pulumiPipelineConfig;
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
      ...envInputs.pulumiPipelineConfig,
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
