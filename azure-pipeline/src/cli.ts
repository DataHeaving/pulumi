#!/usr/bin/env node
import * as pulumi from "@pulumi/pulumi/automation";
import * as validation from "@data-heaving/common-validation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as pulumiAutomation from "@data-heaving/pulumi-automation";
import { argv, stdin, env } from "process";
import * as fs from "fs/promises";
import { Readable } from "stream";
import * as cliConfig from "./cli-config";
import * as functionality from ".";

// Command-line args:
// [path-to-config-file-or-stdin, [pulumi-command=preview]]
export const main = async () => {
  // Perform parsing arguments
  const args = argv.slice(2); // First two are: "(ts-)node" and "src/commandline"

  // We must do parsing sequentially in this order, as getDoChanges and getConfigPath may modify arg array
  const configFilePath = getConfigPath(args);
  const command = getPulumiCommand(args);

  if (args.length > 0) {
    throw new Error("There was extra data passed as command-line arguments.");
  }

  const config = configFilePath
    ? validation.decodeOrThrow(
        cliConfig.configuration.decode,
        JSON.parse(await readFromFileOrStdin(configFilePath)),
      )
    : undefined;

  const pulumiProgramModule = validation.decodeOrThrow(
    cliConfig.importedModuleExports.decode,
    await import(
      config?.entrypointModuleName ?? cliConfig.defaultEntrypointFileName
    ),
  );
  const { plugins, programConfig, additionalParameters } =
    "default" in pulumiProgramModule
      ? pulumiProgramModule.default
      : pulumiProgramModule.pulumiProgram;
  const envVarName =
    config?.pipelineConfigEnvName ?? cliConfig.defaultPipelineConfigEnvName;
  return await functionality.runPulumiPipelineFromConfig({
    // Log to console
    eventEmitters: {
      initCommandEventEmitter: pulumiAutomation
        .consoleLoggingInitEventEmitterBuilder()
        .createEventEmitter(),
      runCommandEventEmitter: pulumiAutomation
        .consoleLoggingRunEventEmitterBuilder()
        .createEventEmitter(),
    },
    config: validation.decodeOrThrow(
      cliConfig.pipelineConfiguration.decode,
      JSON.parse(
        env[envVarName] ??
          doThrow(
            `Please supply config stored in keyvault secret via "${envVarName}" environment variable.`,
          ),
      ),
    ),
    command: command ?? cliConfig.defaultCommand.value,
    plugins: plugins.map((pluginNameOrInfo) =>
      typeof pluginNameOrInfo === "string"
        ? pluginNameOrInfo
        : pulumiAutomation.getFullPluginPackageInformationFromDescription({
            ...pluginNameOrInfo,
            processVersion: (v) =>
              `${pluginNameOrInfo.prependToVersion ?? "v"}${v}${
                pluginNameOrInfo.appendToVersion ?? ""
              }`,
          }),
    ),
    programConfig: {
      ...programConfig,
      program: programConfig.program as pulumi.PulumiFn,
    },
    // TODO this is fugly, needs better code
    additionalParameters: additionalParameters
      ? {
          ...additionalParameters,
          processEnvVars: additionalParameters.processEnvVars as (
            envVars: Record<string, string>,
          ) => Record<string, string>,
          processLocalWorkspaceOptions:
            additionalParameters.processLocalWorkspaceOptions as (
              options: pulumiAzure.InitialLocalWorkspaceOptions,
            ) => pulumi.LocalWorkspaceOptions,
        }
      : undefined,
  });
};

const getConfigPath = (args: Array<string>) => {
  const maybePath = args[0];
  const pathInArgs =
    !!maybePath && (maybePath === "-" || maybePath.search(/^[./]/) === 0);

  if (pathInArgs) {
    args.splice(0, 1);
  }
  return maybePath;
};

const getPulumiCommand = (args: Array<string>) => {
  let command: pulumiAutomation.PulumiCommand | undefined;
  if (args.length > 0) {
    command = validation.decodeOrThrow(cliConfig.pulumiCommand.decode, args[0]);
    args.splice(0, 1);
  }
  return command;
};

const readStream = async (stream: Readable) => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const readFromFileOrStdin = (path: string) => {
  return path === "-" ? readStream(stdin) : fs.readFile(path, "utf8");
};

const doThrow = <T>(msg: string): T => {
  throw new Error(msg);
};

void (async () => {
  try {
    await main();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("ERROR", e);
  }
})();
