import * as pulumi from "@pulumi/pulumi/automation";
import * as pulumiAutomation from "@data-heaving/pulumi-automation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as config from "@data-heaving/pulumi-azure-pipeline-config";
import * as fs from "fs/promises";
import * as authUtils from "./auth";

export interface RunFromConfigOptions<
  TCommand extends pulumiAutomation.PulumiCommand,
> {
  config: config.PipelineConfig;
  plugins: ReadonlyArray<pulumiAutomation.PulumiPluginDescription>;
  command: TCommand;
  programConfig: pulumi.InlineProgramArgs;
  additionalParameters?: Partial<
    {
      skipDeletePfxPathIfCreated: boolean;
    } & Omit<
      pulumiAzure.PulumiAzureBackendStackAcquiringConfig["pulumi"],
      "auth" | "backendConfig" | "programArgs"
    >
  >;
}

export const runPulumiPipelineFromConfig = async <
  TCommand extends pulumiAutomation.PulumiCommand,
>({
  config,
  plugins,
  command,
  programConfig,
  additionalParameters,
}: RunFromConfigOptions<TCommand>) => {
  const { auth, pfx } = await authUtils.configAuthToPulumiAuth(config.auth);
  try {
    return await runPulumiPipeline(
      {
        pulumi: {
          ...(additionalParameters || {}),
          auth,
          backendConfig: config.backend,
          programArgs: programConfig,
        },
        azure: config.azure,
      },
      plugins,
      command,
    );
  } finally {
    if (pfx && !(additionalParameters?.skipDeletePfxPathIfCreated === true)) {
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
) => {
  const stack = await pulumiAzure.getOrCreateStackWithAzureBackend(stackArgs);
  await pulumiAutomation.initPulumiExecution(
    pulumiAutomation
      .consoleLoggingInitEventEmitterBuilder()
      .createEventEmitter(),
    stack,
    plugins,
  );
  // There is some weird TS compiler bug causing return type of this function to become Promise<PreviewResult|DestroyResult>, unless we explicitly specify generic argument here.
  return await pulumiAutomation.runPulumiInfrastructureCommandForStack<pulumiAutomation.PulumiCommand>(
    pulumiAutomation
      .consoleLoggingRunEventEmitterBuilder()
      .createEventEmitter(),
    stack,
    command,
  );
};
