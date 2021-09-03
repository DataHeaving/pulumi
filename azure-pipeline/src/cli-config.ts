import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";

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
     * If not specified, the value of @see defaultEntrypointFileName is used.
     */
    entrypointModuleName: validation.nonEmptyString,
  },
  "PulumiAzureBackendPipelineConfiguration",
);

export const defaultPipelineConfigEnvName = "AZURE_PIPELINE_CONFIG";
export const defaultEntrypointFileName = "./index.js";

/**
 * This runtime validation imitates compile-time type "PipelineConfig" in "@data-heaving/pulumi-azure-pipeline-config" module
 */
export const pipelineConfiguration = t.type(
  {
    backend: t.type({
      storageAccountName: validation.nonEmptyString,
      storageContainerName: validation.nonEmptyString,
      encryptionKeyURL: validation.urlWithPath,
    }),
    azure: t.type({
      tenantId: validation.uuid,
      subscriptionId: validation.uuid,
    }),
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
const pulumiProgram = t.intersection(
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
          program: t.Function,
        }),
      },
      "PulumiProgramMandatory",
    ),
    t.partial(
      {
        additionalParameters: t.partial({
          skipDeletePfxPathIfCreated: t.boolean,
          processEnvVars: t.Function,
          processLocalWorkspaceOptions: t.Function,
        }),
      },
      "PulumiProgramOptional",
    ),
  ],
  "PulumiProgram",
);

/**
 * This is runtime validation for JS module containing Pulumi program.
 */
export const importedModuleExports = t.union(
  [
    t.type(
      {
        default: pulumiProgram,
      },
      "ImportedModuleExportsViaDefault",
    ),
    t.type(
      {
        pulumiProgram,
      },
      "ImportedModuleExportsViaName",
    ),
  ],
  "ImportedModuleExports",
);
