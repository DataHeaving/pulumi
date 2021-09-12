import * as pulumi from "@pulumi/pulumi/automation";
import * as pulumiAutomation from "@data-heaving/pulumi-automation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as config from "@data-heaving/pulumi-azure-pipeline-config";
import * as fs from "fs/promises";
import * as authUtils from "./auth";

export interface RunFromConfigOptions<
  TCommand extends pulumiAutomation.PulumiCommand,
> {
  eventEmitters: PulumiPipelineEventEmitters;
  config: config.PipelineConfig;
  plugins: ReadonlyArray<pulumiAutomation.PulumiPluginDescription>;
  command: TCommand;
  programConfig: (
    auth: pulumiAzure.PulumiAzureBackendAuth,
  ) => Promise<pulumi.InlineProgramArgs>;
  additionalParameters?: (
    envConfig: pulumiAzure.AzureProviderEnvVarsConfig,
  ) => AdditionalParameters;
}

export type AdditionalParameters = Partial<
  {
    skipDeletePfxPathIfCreated: boolean;
  } & Omit<
    pulumiAzure.PulumiAzureBackendStackAcquiringConfig["pulumi"],
    "auth" | "backendConfig" | "programArgs"
  >
>;

export const runPulumiPipelineFromConfig = async <
  TCommand extends pulumiAutomation.PulumiCommand,
>({
  config,
  plugins,
  command,
  programConfig,
  additionalParameters,
  eventEmitters,
}: RunFromConfigOptions<TCommand>) => {
  let additionalParametersObject: AdditionalParameters | undefined;
  const { auth, pfx } = await authUtils.configAuthToPulumiAuth(config.auth);
  try {
    additionalParametersObject = additionalParameters
      ? additionalParameters({ auth, azure: config.azure })
      : {};
    return await runPulumiPipeline(
      {
        pulumi: {
          ...additionalParametersObject,
          auth,
          backendConfig: config.backend,
          programArgs: await programConfig(auth),
        },
        azure: config.azure,
      },
      plugins,
      command,
      eventEmitters,
    );
  } finally {
    if (
      pfx &&
      !(additionalParametersObject?.skipDeletePfxPathIfCreated === true)
    ) {
      await fs.rm(pfx.path);
    }
  }
};

export const runPulumiPipeline = async <
  TCommand extends pulumiAutomation.PulumiCommand,
>(
  stackArgs: pulumiAzure.PulumiAzureBackendStackAcquiringConfig,
  plugins: ReadonlyArray<pulumiAutomation.PulumiPluginDescription>,
  command: TCommand,
  eventEmitters: PulumiPipelineEventEmitters,
) => {
  // ReturnType<pulumi.Stack[TCommand]> <- didn't work, because "async must be Promise"
  const stack = await pulumiAzure.getOrCreateStackWithAzureBackend(stackArgs);
  await pulumiAutomation.initPulumiExecution(
    eventEmitters.initCommandEventEmitter,
    stack,
    plugins,
  );
  // There is some weird TS compiler bug causing return type of this function to become Promise<PreviewResult|DestroyResult>, unless we explicitly do cast here + at
  return (await pulumiAutomation.runPulumiInfrastructureCommandForStack(
    eventEmitters.runCommandEventEmitter,
    stack,
    command,
  )) as PulumiCommandResult<TCommand>;
};

export type PulumiPipelineEventEmitters = {
  initCommandEventEmitter: pulumiAutomation.InitEventEmitter;
  runCommandEventEmitter: pulumiAutomation.RunEventEmitter;
};

export type PulumiCommandResult<
  TCommand extends pulumiAutomation.PulumiCommand,
> = TCommand extends "up"
  ? pulumi.UpResult
  : TCommand extends "preview"
  ? pulumi.PreviewResult
  : TCommand extends "destroy"
  ? pulumi.DestroyResult
  : never;
