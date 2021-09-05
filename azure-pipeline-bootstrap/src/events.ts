import * as common from "@data-heaving/common";
import * as types from "./types";

// This is virtual interface - no instances implementing this are ever created
export interface VirtualPipelineBootstrapEvents {
  beforeRunningPulumiPortion: {
    organization: types.Organization;
    doChanges: boolean;
  };
}
export type PipelineBootstrapEventEmitter =
  common.EventEmitter<VirtualPipelineBootstrapEvents>;

export const createBootstrapPipelineEventEmitterBuilder = () =>
  new common.EventEmitterBuilder<VirtualPipelineBootstrapEvents>();

export const consoleLoggingBootstrapPipelineEventEmitterBuilder = (
  logMessagePrefix?: Parameters<typeof common.createConsoleLogger>[0],
  builder?: common.EventEmitterBuilder<VirtualPipelineBootstrapEvents>,
  consoleAbstraction?: common.ConsoleAbstraction,
) => {
  if (!builder) {
    builder = createBootstrapPipelineEventEmitterBuilder();
  }

  const logger = common.createConsoleLogger(
    logMessagePrefix,
    consoleAbstraction,
  );

  builder.addEventListener("beforeRunningPulumiPortion", (arg) =>
    logger(
      `Starting Pulumi command "${
        arg.doChanges ? "up" : "preview"
      }" for environments ${arg.organization.environments
        .map(({ name }) => `"${name}"`)
        .join(", ")}.`,
    ),
  );

  return builder;
};
