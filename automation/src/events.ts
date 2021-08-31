import * as common from "@data-heaving/common";
import * as types from "./types";
import * as errors from "./errors";

// This is virtual interface - no instances implementing this are ever created
export interface VirtualEvents {
  pluginInstalled: {
    pluginInfo: types.PulumiPluginPackageInformationFull;
    version: string;
  };
  pluginInstallationError: errors.PulumiPluginInstallationError;
}

export type EventEmitter = common.EventEmitter<VirtualEvents>;

export const createEventEmitterBuilder = () =>
  new common.EventEmitterBuilder<VirtualEvents>();

export const consoleLoggingEventEmitterBuilder = (
  logMessagePrefix?: Parameters<typeof common.createConsoleLogger>[0],
  builder?: common.EventEmitterBuilder<VirtualEvents>,
  consoleAbstraction?: common.ConsoleAbstraction,
) => {
  if (!builder) {
    builder = createEventEmitterBuilder();
  }

  const logger = common.createConsoleLogger(
    logMessagePrefix,
    consoleAbstraction,
  );

  builder.addEventListener(
    "pluginInstalled",
    ({ pluginInfo: { pluginName }, version }) =>
      logger(
        `Successfully installed plugin "${pluginName}" with version "${version}".`,
      ),
  );

  builder.addEventListener(
    "pluginInstallationError",
    ({ pluginInfo, errorCode }) =>
      logger(errors.createErrorMessage(pluginInfo, errorCode), true),
  );

  return builder;
};
