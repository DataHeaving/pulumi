import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as pulumiAzure from "@data-heaving/pulumi-azure";
import { cwd } from "process";

/**
 * This is runtime validation for command-line arguments passed to this CLI program
 */
export const defaultCommand = t.literal("preview");
export const pulumiCommand = t.union(
  [defaultCommand, t.literal("up"), t.literal("destroy"), t.undefined],
  "PulumiCommand",
); // Which pulumi command to execute

/**
 * This is runtime validation for configuration file about the pipeline that can be stored e.g. to Git repo
 */
export const configuration = t.partial(
  {
    /**
     * Name of the environment variable which holds the JSON-encoded value of @see pipelineConfiguration
     */
    pipelineConfigEnvName: validation.nonEmptyString,
    /**
     * Path to .js file (without .js suffix) where pulumi program is located. Must have default export, or export called "pulumiProgram".
     * If not specified, the value of @see createDefaultEntrypointFileName is used.
     */
    entrypointModuleName: validation.nonEmptyString,

    /**
     * Path where the output of Pulumi command execution should be stored for further processing.
     * If not specified, the value of @see createDefaultPulumiCommandOutputFile is used.
     */
    pulumiCommandOutputFile: validation.nonEmptyString,
  },
  "PulumiAzureBackendPipelineConfiguration",
);

export const defaultPipelineConfigEnvName = "AZURE_PIPELINE_CONFIG";
export const createDefaultEntrypointFileName = () => `${cwd()}/dist/index.js`;
/**
 * Since this CLI is designed to be run with Docker, the default path for Pulumi command result file is `/pulumi-out/pulumi-out.json`.
 * @returns The default path for Pulumi command result file
 */
export const createDefaultPulumiCommandOutputFile = () =>
  "/pulumi-out/pulumi-out.json";

/**
 * This runtime validation imitates compile-time type "PipelineConfig" in "@data-heaving/pulumi-azure-pipeline-config" module
 */
const azure = t.type({
  tenantId: validation.uuid,
  subscriptionId: validation.uuid,
});
export type AzureEnvironment = t.TypeOf<typeof azure>;
export const pipelineConfiguration = t.type(
  {
    backend: t.type({
      storageAccountName: validation.nonEmptyString,
      storageContainerName: validation.nonEmptyString,
      encryptionKeyURL: validation.urlWithPath,
    }),
    azure,
    auth: t.union([
      t.type({
        type: t.literal("msi"),
        clientId: validation.uuid,
        resourceId: validation.nonEmptyString,
      }),
      t.type({
        type: t.literal("sp"),
        clientId: validation.uuid,
        keyPEM: validation.nonEmptyString,
        certPEM: validation.nonEmptyString,
        storageAccountKey: validation.nonEmptyString,
      }),
    ]),
  },
  "PipelineConfiguration",
);

/**
 * This is runtime validation for exported variable of JS module containing Pulumi program.
 */
const pluginName = validation.nonEmptyString;
const additionalParameters = t.partial(
  {
    skipDeletePfxPathIfCreated: t.boolean,
    processEnvVars: t.Function,
    processLocalWorkspaceOptions: t.Function,
    processAdditionalEnvVars: t.Function,
  },
  "PulumiPipelineAdditionalParameters",
);
export type PulumiPipelineAdditionalParameters = t.TypeOf<
  typeof additionalParameters
>;
const pulumiPipelineExport = t.intersection(
  [
    t.type(
      {
        plugins: t.array(
          t.union([
            pluginName,
            t.intersection([
              t.type({
                pluginName,
              }),
              t.partial({
                packageName: validation.nonEmptyString,
                utilsSuffix: t.string,
                getVersionFunctionName: t.string,
                prependToVersion: t.string,
                appendToVersion: t.string,
              }),
            ]),
          ]),
        ),
        programConfig: t.type({
          projectName: validation.nonEmptyString,
          stackName: validation.nonEmptyString,
          program: t.Function, // Actual type: AzureBackendPulumiProgram
        }),
      },
      "PulumiProgramMandatory",
    ),
    t.partial(
      {
        additionalParameters,
        beforePulumiCommandExecution: t.Function, // Actual type: AzureBackendPulumiProgram<void>
      },
      "PulumiProgramOptional",
    ),
  ],
  "PulumiProgram",
);

export interface AzureBackendPulumiProgramArgs {
  auth: pulumiAzure.PulumiAzureBackendAuth;
  azure: AzureEnvironment;
}

export type AzureBackendPulumiProgram<
  TResult = void | Record<string, unknown>,
> = (args: AzureBackendPulumiProgramArgs) => Promise<TResult>;

/**
 * This is runtime validation for JS module containing Pulumi program.
 */
export const importedModuleExports = t.union(
  [
    t.type(
      {
        default: pulumiPipelineExport,
      },
      "ImportedModuleExportsViaDefault",
    ),
    t.type(
      {
        pulumiProgram: pulumiPipelineExport,
      },
      "ImportedModuleExportsViaName",
    ),
  ],
  "ImportedModuleExports",
);
