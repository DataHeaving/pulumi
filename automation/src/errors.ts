import * as types from "./types";

export type PulumiPluginInstallationErrorCodes =
  | "ModuleLoadError"
  | "NoExportedGetVersionMember"
  | "ExportedGetVersionMemberIsNotAFunction"
  | "ExportedGetVersionFunctionReturnedNonString";

export class PulumiPluginInstallationError extends Error {
  public constructor(
    public readonly pluginInfo: types.PulumiPluginPackageInformationFull,
    public readonly errorCode: PulumiPluginInstallationErrorCodes,
    public readonly causedBy?: unknown,
  ) {
    super(createErrorMessage(pluginInfo, errorCode));
  }
}

export const createErrorMessage = (
  pluginInfo: types.PulumiPluginPackageInformationMandatory,
  errorCode: PulumiPluginInstallationErrorCodes,
) => `Error when installing plugin "${pluginInfo.pluginName}": "${errorCode}".`;

export class PulumiPluginInstallationMultiError extends Error {
  public constructor(
    public readonly errors: ReadonlyArray<PulumiPluginInstallationError>,
  ) {
    super(`Errors when installing plugin`);
  }
}
