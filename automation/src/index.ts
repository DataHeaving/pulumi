import * as pulumi from "@pulumi/pulumi/automation";
import * as init from "./init";
import * as run from "./run";

export * from "./init";
export * from "./run";

export const runPulumiPipeline = async <
  TCommands extends [...ReadonlyArray<run.PulumiCommand>],
>(
  stack: pulumi.Stack,
  plugins: ReadonlyArray<init.PulumiPluginDescription>,
  commands: TCommands,
  eventEmitters: PulumiPipelineEventEmitters,
) => {
  // ReturnType<pulumi.Stack[TCommand]> <- didn't work, because "async must be Promise"
  await init.initPulumiExecution(
    eventEmitters.initCommandEventEmitter,
    stack,
    plugins,
  );
  const retVal: [...Array<PulumiCommandResult<TCommands[number]>>] = [];
  for (const command of commands) {
    retVal.push(
      (await run.runPulumiInfrastructureCommandForStack(
        eventEmitters.runCommandEventEmitter,
        stack,
        command,
      )) as PulumiCommandResult<TCommands[number]>,
    );
  }
  return retVal;
};

export type PulumiPipelineEventEmitters = {
  initCommandEventEmitter: init.InitEventEmitter;
  runCommandEventEmitter: run.RunEventEmitter;
};

export type PulumiCommandResult<TCommand extends run.PulumiCommand> =
  TCommand extends "up"
    ? pulumi.UpResult
    : TCommand extends "preview"
    ? pulumi.PreviewResult
    : TCommand extends "destroy"
    ? pulumi.DestroyResult
    : TCommand extends "refresh"
    ? pulumi.RefreshResult
    : never;
