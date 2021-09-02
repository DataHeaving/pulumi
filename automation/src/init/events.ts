import * as common from "@data-heaving/common";
import * as types from "./types";
import * as errors from "./errors";

// This is virtual interface - no instances implementing this are ever created
export interface VirtualInitEvents {
  pluginInstalled: {
    pluginInfo: types.PulumiPluginPackageInformationFull;
    version: string;
  };
  pluginInstallationError: errors.PulumiPluginInstallationError;
}

export type InitEventEmitter = common.EventEmitter<VirtualInitEvents>;

export const createInitEventEmitterBuilder = () =>
  new common.EventEmitterBuilder<VirtualInitEvents>();

export const consoleLoggingInitEventEmitterBuilder = (
  logMessagePrefix?: Parameters<typeof common.createConsoleLogger>[0],
  builder?: common.EventEmitterBuilder<VirtualInitEvents>,
  consoleAbstraction?: common.ConsoleAbstraction,
) => {
  if (!builder) {
    builder = createInitEventEmitterBuilder();
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
