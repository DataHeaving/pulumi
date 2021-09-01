import * as id from "@azure/identity";
import * as utils from "@data-heaving/common";
import * as validation from "@data-heaving/common-validation";
import { argv, env } from "process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as uuid from "uuid";
import * as cmdConfig from "./cli-config";
import * as program from ".";
import * as pulumiSetup from "./bootstrap";

// Command-line args:
// [doChanges, [configPath, [...authKinds]]]
const main = async () => {
  // Perform parsing arguments
  // We must do it sequentially in this order, as getDoChanges and getConfigPath may modify arg array
  const args = argv.slice(2); // First two are: "ts-node" and "src/commandline"
  const doChanges = getDoChanges(args);
  const configPath = getConfigPath(args);
  const authentications = validation.decodeOrThrow(
    cmdConfig.authenticationKinds.decode,
    args,
  );
  if (authentications.length <= 0) {
    // Default authentications, in this order
    authentications.push("env", "cli", "msi", "device");
  }

  const credentials = new id.ChainedTokenCredential(
    ...utils
      .deduplicate(authentications, (a) => a)
      .map((authentication) => {
        switch (authentication) {
          case "device":
            return new id.DeviceCodeCredential();
          case "env":
            return new id.EnvironmentCredential();
          case "cli":
            return new id.AzureCliCredential();
          case "msi":
            return new id.ManagedIdentityCredential();
        }
      }),
  );

  const { tempDir, programConfig } = await loadConfig(credentials, configPath);
  try {
    await program.main({
      credentials,
      doChanges,
      ...programConfig,
    });
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true });
    }
  }
};

const getDoChanges = (args: Array<string>) => {
  const doChanges = validation.decodeOrDefault(
    cmdConfig.booleanString.decode,
    args[0],
  );
  if (doChanges !== undefined) {
    args.splice(0, 1);
  }
  return doChanges === "true";
};

const getConfigPath = (args: Array<string>) => {
  const maybePath = args[0];
  const pathInArgs =
    !!maybePath && (maybePath === "-" || maybePath.search(/^[./]/) === 0);

  if (pathInArgs) {
    args.splice(0, 1);
  }
  return pathInArgs ? maybePath : "./config/config.json";
};

const loadConfig = async (
  credentials: id.TokenCredential,
  configPath: string,
) => {
  const { bootstrapperApp, ...parsed } = validation.decodeOrThrow(
    cmdConfig.config.decode,
    // TODO read stdin if configPath == "-"
    JSON.parse(await fs.readFile(configPath, "utf-8")),
  );
  const {
    pulumiEncryptionKeyBitsForBootstrapper,
    pulumiEncryptionKeyBitsForEnvSpecificPipeline,
  } = parsed.pulumi || {};
  let programConfig: Omit<program.Inputs, "credentials" | "doChanges">;
  let tempDir: string | undefined;
  if (bootstrapperApp.type === "sp") {
    const { authentication, envSpecificPulumiPipelineSPAuth } = bootstrapperApp;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulumi-bootstrap-"));
    const keyAndCertPaths = {
      keyPath: path.join(tempDir, `key-${uuid.v4()}.pem`),
      certPath: path.join(tempDir, `cert-${uuid.v4()}.pem`),
      pfxPath: path.join(tempDir, `x509-${uuid.v4()}.pfx`),
    };
    let keyAndCertPEM: string | undefined;
    try {
      keyAndCertPEM = await pulumiSetup.tryGetSecretValue(credentials, {
        kvURL: `https://${pulumiSetup.constructVaultName(
          parsed.organization.name,
        )}.vault.azure.net`,
        secretName: pulumiSetup.constructBootstrapperAppAuthSecretName(),
      });
    } catch {
      // Ignore
    }

    if (keyAndCertPEM) {
      const beginCertIdx = keyAndCertPEM.search(pulumiSetup.BEGIN_CERTIFICATE);
      await Promise.all(
        [
          [keyAndCertPaths.keyPath, keyAndCertPEM.substr(0, beginCertIdx)],
          [keyAndCertPaths.certPath, keyAndCertPEM.substr(beginCertIdx)],
        ].map(async ([path, contents]) => await fs.writeFile(path, contents)),
      );
    }

    const pwEnvName = authentication.pfxPasswordEnvName;
    programConfig = {
      ...parsed,
      organization: constructOrganizationObject(parsed),
      bootstrapperApp: {
        ...bootstrapperApp,
        authentication: {
          ...authentication,
          tempDir,
          ...keyAndCertPaths,
          pfxPassword: (pwEnvName ? env[pwEnvName] : undefined) ?? "",
          rsaBits: authentication.rsaBits ?? 4096,
          certValidityPeriodDays: authentication.certValidityPeriodDays ?? 7000, // A bit under 10 years
        },
        envSpecificPulumiPipelineSPAuth: envSpecificPulumiPipelineSPAuth
          ? {
              ...envSpecificPulumiPipelineSPAuth,
              rsaBits: envSpecificPulumiPipelineSPAuth?.rsaBits ?? 4096,
              validityHours:
                envSpecificPulumiPipelineSPAuth?.validityHours ?? 90000, // A bit over 10yrs
            }
          : undefined,
      },
      pipelineConfigs: constructPulumiPipelineConfigs(
        pulumiEncryptionKeyBitsForBootstrapper,
        pulumiEncryptionKeyBitsForEnvSpecificPipeline,
      ),
    };
  } else {
    programConfig = {
      ...parsed,
      organization: constructOrganizationObject(parsed),
      bootstrapperApp,
      pipelineConfigs: constructPulumiPipelineConfigs(
        pulumiEncryptionKeyBitsForBootstrapper,
        pulumiEncryptionKeyBitsForEnvSpecificPipeline,
      ),
    };
  }

  return {
    programConfig,
    tempDir,
  };
};

const constructPulumiPipelineConfigs = (
  pulumiEncryptionKeyBitsForBootstrapper:
    | cmdConfig.PulumiPipelineConfig
    | undefined,
  pulumiEncryptionKeyBitsForEnvSpecificPipeline:
    | cmdConfig.PulumiPipelineConfig
    | undefined,
) => ({
  pulumiEncryptionKeyBitsForBootstrapper:
    pulumiEncryptionKeyBitsForBootstrapper ?? 4096,
  pulumiEncryptionKeyBitsForEnvSpecificPipeline:
    pulumiEncryptionKeyBitsForEnvSpecificPipeline ?? 4096,
});

const constructOrganizationObject = ({
  organization,
  azure: { subscriptionId },
}: Pick<cmdConfig.Config, "organization" | "azure">) => ({
  ...organization,
  environments: organization.environments.map((envNameOrConfig) =>
    typeof envNameOrConfig === "string"
      ? {
          name: envNameOrConfig,
          subscriptionId,
        }
      : envNameOrConfig,
  ),
});

void (async () => {
  try {
    await main();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("ERROR", e);
  }
})();
