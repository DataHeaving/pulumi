#!/usr/bin/env node
import * as pulumi from "@pulumi/pulumi/automation";
import * as validation from "@data-heaving/common-validation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as pulumiAutomation from "@data-heaving/pulumi-automation";
import * as uuid from "uuid";
import { argv, stdin, env, exit } from "process";
import * as fs from "fs/promises";
import { Readable } from "stream";
import * as cliConfig from "./cli-config";
import * as functionality from ".";
import * as os from "os";

// Command-line args:
// [path-to-config-file-or-stdin, [pulumi-command=preview]]
export const main = async () => {
  // Perform parsing arguments
  const args = argv.slice(2); // First two are: "(ts-)node" and "src/commandline"

  // We must do parsing sequentially in this order, as getDoChanges and getConfigPath may modify arg array
  const configFilePath = getConfigPath(args);
  const givenCommand = getPulumiCommand(args);

  if (args.length > 0) {
    throw new Error("There was extra data passed as command-line arguments.");
  }

  const config = configFilePath
    ? validation.decodeOrThrow(
        cliConfig.configuration.decode,
        JSON.parse(await readFromFileOrStdinOrEnv(configFilePath)),
      )
    : undefined;

  const pulumiProgramModule = validation.decodeOrThrow(
    cliConfig.importedModuleExports.decode,
    await import(
      config?.entrypointModuleName ??
        cliConfig.createDefaultEntrypointFileName()
    ),
  );
  const { plugins, programConfig, additionalParameters } =
    "default" in pulumiProgramModule
      ? pulumiProgramModule.default
      : pulumiProgramModule.pulumiProgram;
  const envVarName =
    config?.pipelineConfigEnvName ?? cliConfig.defaultPipelineConfigEnvName;
  const pipelineConfig = validation.decodeOrThrow(
    cliConfig.pipelineConfiguration.decode,
    JSON.parse(
      env[envVarName] ??
        doThrow(
          `Please supply config stored in keyvault secret via "${envVarName}" environment variable.`,
        ),
    ),
  );
  const command = givenCommand ?? cliConfig.defaultCommand.value;
  const pulumiCommandResult = await functionality.runPulumiPipelineFromConfig({
    // Log to console
    eventEmitters: {
      initCommandEventEmitter: pulumiAutomation
        .consoleLoggingInitEventEmitterBuilder()
        .createEventEmitter(),
      runCommandEventEmitter: pulumiAutomation
        .consoleLoggingRunEventEmitterBuilder()
        .createEventEmitter(),
    },
    config: pipelineConfig,
    command,
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
    additionalParameters: getAdditionalParameters(additionalParameters ?? {}),
  });

  const pulumiCommandOutput =
    config?.pulumiCommandOutputFile ??
    cliConfig.createDefaultPulumiCommandOutputFile();
  if (pulumiCommandOutput.length > 0) {
    await fs.writeFile(
      pulumiCommandOutput,
      JSON.stringify({
        command,
        ...("outputs" in pulumiCommandResult
          ? {
              outputs: pulumiCommandResult.outputs,
              summary: pulumiCommandResult.summary,
            }
          : {
              summary:
                "changeSummary" in pulumiCommandResult
                  ? pulumiCommandResult.changeSummary
                  : pulumiCommandResult.summary,
            }),
      }),
      "utf8",
    );
  }
};

const getAdditionalParameters =
  ({
    processEnvVars,
    processAdditionalEnvVars,
    processLocalWorkspaceOptions,
    ...additionalParameters
  }: cliConfig.PulumiPipelineAdditionalParameters) =>
  (
    envVarConfig: pulumiAzure.AzureProviderEnvVarsConfig,
  ): functionality.AdditionalParameters => ({
    ...additionalParameters,
    // TODO this is fugly, needs better code
    processEnvVars:
      processEnvVars || processAdditionalEnvVars
        ? (envVars) => {
            let retVal = envVars;
            if (processEnvVars) {
              retVal = (
                processEnvVars as (
                  envVars: Record<string, string>,
                ) => Record<string, string>
              )(retVal);
            } else {
              retVal = pulumiAzure.getAzureProviderEnvVars(envVarConfig);
            }
            if (processAdditionalEnvVars) {
              retVal = (
                processAdditionalEnvVars as (
                  envVars: Record<string, string>,
                ) => Record<string, string>
              )(retVal);
            }
            return retVal;
          }
        : undefined,
    processLocalWorkspaceOptions: (opts) => {
      let retVal: pulumi.LocalWorkspaceOptions = opts;
      // We must modify pulumiHome when the pipeline will be running in GitHub workflow inside docker image (at least on Node 16). Otherwise there will be error:
      // fatal: error An assertion has failed: could not get workspace path. source error: getting current user: luser: unable to get current user
      retVal.pulumiHome = `${os.tmpdir()}/${uuid.v4()}`;
      if (processLocalWorkspaceOptions) {
        retVal = (
          processLocalWorkspaceOptions as (
            options: pulumiAzure.InitialLocalWorkspaceOptions,
          ) => pulumi.LocalWorkspaceOptions
        )(opts);
      }
      return retVal;
    },
  });

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

const STDIN = "-";
const ENV_PREFIX = "env:";
const readFromFileOrStdinOrEnv = (pathOrEnvName: string) => {
  let result: () => Promise<string>;
  let source: string;
  if (pathOrEnvName === STDIN) {
    result = () => readStream(stdin);
    source = "stdin";
  } else if (pathOrEnvName.startsWith(ENV_PREFIX)) {
    const envVarName = pathOrEnvName.substr(ENV_PREFIX.length);
    result = () => Promise.resolve(env[envVarName] ?? "");
    source = `environment variable "${envVarName}"`;
  } else {
    result = () => fs.readFile(pathOrEnvName, "utf8");
    source = `file at path "${pathOrEnvName}"`;
  }
  // eslint-disable-next-line no-console
  console.log(`Reading configuration from ${source}.`);
  return result();
};

const getConfigPath = (args: Array<string>) => {
  const maybePath = args[0];
  const pathInArgs =
    !!maybePath &&
    (maybePath === STDIN ||
      maybePath.startsWith(ENV_PREFIX) ||
      maybePath.startsWith(".") ||
      maybePath.startsWith("/"));

  if (pathInArgs) {
    args.splice(0, 1);
  }
  return pathInArgs ? maybePath : undefined;
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
    exit(1);
  }
})();
