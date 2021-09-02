import * as common from "@data-heaving/common";
import * as types from "./types";

// This is virtual interface - no instances implementing this are ever created
export interface VirtualRunEvents {
  pulumiOutput: {
    command: types.PulumiCommand;
    outputFragment: string;
  };
}

export type RunEventEmitter = common.EventEmitter<VirtualRunEvents>;

export const createRunEventEmitterBuilder = () =>
  new common.EventEmitterBuilder<VirtualRunEvents>();

export const consoleLoggingRunEventEmitterBuilder = (
  logMessagePrefix?: Parameters<typeof common.createConsoleLogger>[0],
  builder?: common.EventEmitterBuilder<VirtualRunEvents>,
  consoleAbstraction?: common.ConsoleAbstraction,
) => {
  if (!builder) {
    builder = createRunEventEmitterBuilder();
  }

  const logger = common.createConsoleLogger(
    logMessagePrefix,
    consoleAbstraction,
  );

  builder.addEventListener("pulumiOutput", ({ outputFragment }) =>
    logger(outputFragment),
  );

  return builder;
};
