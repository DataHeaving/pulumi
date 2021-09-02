import * as pulumi from "@pulumi/pulumi/automation";
import * as pulumiAutomation from "@data-heaving/pulumi-automation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as config from "@data-heaving/pulumi-azure-pipeline-config";
import * as fs from "fs/promises";
import * as authUtils from "./auth";

export const runPulumiCommandFromConfig = async <
  TCommand extends pulumiAutomation.PulumiCommand,
>(
  config: config.PipelineConfig,
  plugins: ReadonlyArray<pulumiAutomation.PulumiPluginDescription>,
  command: TCommand,
  programConfig: pulumi.InlineProgramArgs,
  skipDeletePfxPathIfCreated = false,
) => {
  const { auth, pfx } = await authUtils.configAuthToPulumiAuth(config.auth);
  try {
    return await runPulumiCommand(
      {
        pulumi: {
          auth,
          backendConfig: config.backend,
          programArgs: programConfig,
          // TODO allow customization of these two
          // processEnvVars,
          // processLocalWorkspaceOptions
        },
        azure: config.azure,
      },
      plugins,
      command,
    );
  } finally {
    if (pfx && !(skipDeletePfxPathIfCreated === true)) {
      await fs.rm(pfx.path);
    }
  }
};
export const runPulumiCommand = async <
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

  return await pulumiAutomation.runPulumiInfrastructureCommandForStack(
    pulumiAutomation
      .consoleLoggingRunEventEmitterBuilder()
      .createEventEmitter(),
    stack,
    command,
  );
};
