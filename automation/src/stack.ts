import * as pulumi from "@pulumi/pulumi/automation";
import * as types from "./types";
import * as errors from "./errors";
import * as events from "./events";

export type PulumiPluginDescription =
  | string
  | types.PulumiPluginPackageInformation;

export const initPulumiExecution = async (
  eventEmitter: events.EventEmitter,
  stack: pulumi.Stack,
  plugins: ReadonlyArray<PulumiPluginDescription>,
) => {
  const loadErrors = (
    await Promise.all(
      plugins.map(async (pluginDescription) => {
        const pluginInfo =
          getFullPluginPackageInformationFromDescription(pluginDescription);
        const {
          pluginName,
          packageName,
          utilsSuffix,
          getVersionFunctionName,
          processVersion,
        } = pluginInfo;
        const importablePackage = `${packageName}${utilsSuffix}`;
        let pluginLoadError: errors.PulumiPluginInstallationError | undefined;
        let importedVersionPackage: unknown;
        try {
          importedVersionPackage = (await import(importablePackage)) as unknown;
        } catch (e) {
          pluginLoadError = new errors.PulumiPluginInstallationError(
            pluginInfo,
            "ModuleLoadError",
            e,
          );
        }
        if (
          importedVersionPackage &&
          typeof importedVersionPackage === "object" &&
          getVersionFunctionName in importedVersionPackage
        ) {
          const getVersion = importedVersionPackage[
            getVersionFunctionName as keyof typeof importedVersionPackage
          ] as unknown;
          if (typeof getVersion == "function") {
            const version = getVersion() as unknown;
            if (typeof version === "string") {
              const pluginVersion = processVersion(version);
              await stack.workspace.installPlugin(pluginName, pluginVersion);
              eventEmitter.emit("pluginInstalled", {
                pluginInfo,
                version: pluginVersion,
              });
            } else {
              pluginLoadError = new errors.PulumiPluginInstallationError(
                pluginInfo,
                "ExportedGetVersionFunctionReturnedNonString",
              );
            }
          } else {
            pluginLoadError = new errors.PulumiPluginInstallationError(
              pluginInfo,
              "ExportedGetVersionMemberIsNotAFunction",
            );
          }
        } else {
          pluginLoadError = new errors.PulumiPluginInstallationError(
            pluginInfo,
            "NoExportedGetVersionMember",
          );
        }

        if (pluginLoadError) {
          eventEmitter.emit("pluginInstallationError", pluginLoadError);
        }
        return pluginLoadError;
      }),
    )
  ).filter(
    (maybeError): maybeError is errors.PulumiPluginInstallationError =>
      !!maybeError,
  );

  if (loadErrors.length > 0) {
    throw new errors.PulumiPluginInstallationMultiError(loadErrors);
  }
};

export const getFullPluginPackageInformation = ({
  pluginName,
  packageName,
  utilsSuffix,
  getVersionFunctionName,
  processVersion,
}: types.PulumiPluginPackageInformation): types.PulumiPluginPackageInformationFull => ({
  pluginName,
  packageName: packageName ?? `@pulumi/${pluginName}`,
  utilsSuffix: utilsSuffix ?? "/utilities",
  getVersionFunctionName: getVersionFunctionName ?? "getVersion",
  processVersion: processVersion ?? defaultProcessVersion,
});

const defaultProcessVersion = (version: string) => `v${version}`;

export const getFullPluginPackageInformationFromDescription = (
  description: PulumiPluginDescription,
) =>
  getFullPluginPackageInformation(
    typeof description === "string" ? { pluginName: description } : description,
  );
