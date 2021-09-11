#!/usr/bin/env node
import * as id from "@azure/identity";
import * as graph from "@microsoft/microsoft-graph-client";
import * as common from "@data-heaving/common";
import * as validation from "@data-heaving/common-validation";
import * as pulumiAutomation from "@data-heaving/pulumi-automation";
import { argv, env, stdin } from "process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as uuid from "uuid";
import { Readable } from "stream";
import * as cmdConfig from "./cli-config";
import * as program from ".";
import * as pulumiSetup from "./bootstrap";

/**
 * Command-line args:
 * [configPath, [doChanges="true"|"false", [...authKinds]]]
 */
const main = async () => {
  // Perform parsing arguments
  // We must do it sequentially in this order, as getDoChanges and getConfigPath may modify arg array
  const args = argv.slice(2); // First two are: "(ts-)node" and "src/commandline"
  const configPath = getConfigPath(args);
  const doChanges = getDoChanges(args);
  const authentications = validation.decodeOrThrow(
    cmdConfig.authenticationKinds.decode,
    args,
  );
  if (authentications.length <= 0) {
    // Default authentications, in this order
    authentications.push("env", "cli", "msi", "device");
  }

  const { credentials, tempDir, programConfig } = await loadConfig(
    authentications,
    configPath,
  );
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
  authenticationKinds: ReadonlyArray<cmdConfig.AuthenticationKind>,
  configPath: string,
) => {
  const fullConfig = validation.decodeOrThrow(
    cmdConfig.config.decode,
    JSON.parse(await readFromFileOrStdin(configPath)),
  );
  const credentials = getCredentials(authenticationKinds, fullConfig);
  const { bootstrapperApp: bootstrapperAppParsed, ...parsed } = fullConfig;
  const { azure, organization } = parsed;

  const {
    pulumiEncryptionKeyBitsForBootstrapper,
    pulumiEncryptionKeyBitsForEnvSpecificPipeline,
  } = parsed.pulumi || {};
  let tempDir: string | undefined;
  let bootstrapperApp: program.BootstrapperApp;
  if (bootstrapperAppParsed.type === "sp") {
    const { authentication, envSpecificPulumiPipelineSPAuth } =
      bootstrapperAppParsed;
    const configSecretName =
      bootstrapperAppParsed.configSecretName ?? "bootstrapper-auth";
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulumi-bootstrap-"));
    const keyAndCertPaths = {
      keyPath: path.join(tempDir, `key-${uuid.v4()}.pem`),
      certPath: path.join(tempDir, `cert-${uuid.v4()}.pem`),
      pfxPath: path.join(tempDir, `x509-${uuid.v4()}.pfx`),
    };
    let keyAndCertPEM: string | undefined;
    try {
      keyAndCertPEM = await pulumiSetup.tryGetSecretValue(
        credentials.credentials,
        {
          kvURL: `https://${pulumiSetup.constructVaultName(
            organization.name,
          )}.vault.azure.net`,
          secretName: configSecretName,
        },
      );
    } catch (e) {
      if (
        e instanceof id.CredentialUnavailable ||
        e instanceof id.AggregateAuthenticationError
      ) {
        throw e;
      }
      // Ignore otherwise
    }

    // eslint-disable-next-line no-console
    console.log(
      `${
        keyAndCertPEM ? "Found previously stored" : "Will generate new"
      } service principal credentials`,
    );

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
    bootstrapperApp = {
      ...bootstrapperAppParsed,
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
      configSecretName,
    };
  } else {
    bootstrapperApp = bootstrapperAppParsed;
  }

  const { subscriptionId } = azure;
  const programConfig: Omit<program.Inputs, "credentials" | "doChanges"> = {
    ...parsed,
    bootstrapperApp,
    organization: {
      ...organization,
      environments: organization.environments.map((envNameOrConfig) =>
        typeof envNameOrConfig === "string"
          ? {
              name: envNameOrConfig,
              subscriptionId,
            }
          : {
              ...envNameOrConfig,
              subscriptionId: envNameOrConfig.subscriptionId ?? subscriptionId,
            },
      ),
    },
    pipelineConfigs: {
      pulumiEncryptionKeyBitsForBootstrapper:
        pulumiEncryptionKeyBitsForBootstrapper ?? 4096,
      pulumiEncryptionKeyBitsForEnvSpecificPipeline:
        pulumiEncryptionKeyBitsForEnvSpecificPipeline ?? 4096,
    },
    eventEmitters: {
      pipelineEventEmitter: program
        .consoleLoggingBootstrapPipelineEventEmitterBuilder()
        .createEventEmitter(),
      bootstrapEventEmitter: program
        .consoleLoggingBootstrapEventEmitterBuilder(
          parsed.logSubscriptionIdToConsole,
        )
        .createEventEmitter(),
      pulumiEventEmitters: {
        initCommandEventEmitter: pulumiAutomation
          .consoleLoggingInitEventEmitterBuilder()
          .createEventEmitter(),
        runCommandEventEmitter: pulumiAutomation
          .consoleLoggingRunEventEmitterBuilder()
          .createEventEmitter(),
      },
    },
  };

  return {
    credentials,
    programConfig,
    tempDir,
  };
};

const OAUTH_SCOPE_MICROSOFT_GRAPH = "https://graph.microsoft.com/.default";

const getCredentials = (
  authenticationKinds: ReadonlyArray<cmdConfig.AuthenticationKind>,
  {
    azure,
    bootstrapperApp,
  }: Pick<cmdConfig.Config, "azure" | "bootstrapperApp">,
): pulumiSetup.BootstrappingCredentials => {
  const givenClientId = env["AZURE_CLIENT_ID"];
  const credentialsInAttemptOrder = common
    .deduplicate(authenticationKinds, (a) => a)
    .map((authentication) => {
      switch (authentication) {
        case "device":
          // Because id.DeviceCodePromptCallback does not expose current scope, we have to do it like this
          return (scopes: ReadonlyArray<string>) =>
            new id.DeviceCodeCredential(
              azure.tenantId, // Supply tenant ID, otherwise will get errors about app + tenant id not being linked
              undefined, // Use Azure CLI client ID
              ({ message }) =>
                // eslint-disable-next-line no-console
                console.log(
                  `${message} (for scope${scopes.length > 1 ? "s" : ""}: ${
                    scopes.length === 1
                      ? `"${scopes[0]}"`
                      : scopes.map((scope) => `"${scope}"`).join(", ")
                  })`,
                ),
            );
        case "env":
          return new id.EnvironmentCredential();
        case "cli":
          return new id.AzureCliCredential();
        case "msi": {
          // The typings are a bit weird for this one
          return givenClientId
            ? new id.ManagedIdentityCredential(givenClientId)
            : new id.ManagedIdentityCredential();
        }
      }
    });
  return {
    credentials: new ChainedCachingTokenFixedScopesCredential(
      credentialsInAttemptOrder.map((credential) => ({
        credential,
        passGivenTokens: true, // Currently can only handle 1 scope at a time, otherwise will get error from OAuth endpoint "AADSTS70011: The provided request must include a 'scope' input parameter. The provided value for the input parameter 'scope' is not valid. The scope <scope list> openid profile offline_access is not valid. static scope limit exceeded."
      })),
      [
        "https://management.azure.com/.default", // For role assignment for bootstrapper app
      ].concat(
        bootstrapperApp.type === "msi"
          ? []
          : [
              "https://vault.azure.net/.default", // For checking for existing bootstrapper app cert config
              OAUTH_SCOPE_MICROSOFT_GRAPH, // For creating and setting up bootstrapper SP in AAD
            ],
      ),
    ),
    givenClientId,
  };
};

/**
 * We are using multiple client libs and scopes during first stage of bootstrapping.
 * Therefore it is good idea to provide centralized credential cache, especially since the Graph library does not even cache its token.
 * This also avoids prompting for device code on every single call when using id.DeviceCodeCredential.
 */
class ChainedCachingTokenFixedScopesCredential
  implements id.TokenCredential, graph.AuthenticationProvider
{
  private _credentials: ReadonlyArray<
    CredentialInfo & {
      errorOrToken: Record<string, Error | id.AccessToken>; // TODO maybe have this as: Record<string, id.AccessToken> | Error, in order to re-querying all previous credentials on scope change... ?
    }
  >;
  public constructor(
    credentials: ReadonlyArray<CredentialInfo>,
    private readonly scopes: ReadonlyArray<string>,
  ) {
    this._credentials = credentials.map((cred) => ({
      ...cred,
      errorOrToken: {},
    }));
  }

  public getToken(
    scopes: common.OneOrMore<string>,
    options?: id.GetTokenOptions,
  ) {
    this.checkScopesFromArgs(scopes);
    // Pass given scopes in case they are used (e.g. AzureCLICredentials only supports one scope)
    return this.doGetToken(
      options,
      typeof scopes === "string" ? [scopes] : scopes,
    );
  }

  public async getAccessToken(
    authenticationProviderOptions?: graph.AuthenticationProviderOptions,
  ) {
    // This is used by graph.Client -> use the default endpoint if no override passed
    const scopes = authenticationProviderOptions?.scopes ?? [
      OAUTH_SCOPE_MICROSOFT_GRAPH,
    ];
    this.checkScopesFromArgs(scopes);
    return (await this.doGetToken(undefined, scopes)).token;
  }

  private async doGetToken(
    options: id.GetTokenOptions | undefined,
    overrideScopes: ReadonlyArray<string>,
  ) {
    let retVal: id.AccessToken | null = null;
    for (const credentialInfo of this._credentials) {
      const { errorOrToken, passGivenTokens } = credentialInfo;
      const currentScopes = passGivenTokens ? overrideScopes : this.scopes;
      const key = currentScopes.join(" ");
      const existing = errorOrToken[key];
      if (!(existing instanceof Error)) {
        if (typeof existing === "object") {
          retVal = existing;
        } else {
          let acquiredTokenOrError: id.AccessToken | Error;
          const { credential } = credentialInfo;
          try {
            acquiredTokenOrError =
              (await (typeof credential === "function"
                ? credential(currentScopes)
                : credential
              ).getToken([...currentScopes], options)) ??
              new Error("Returned token was null");
          } catch (e) {
            acquiredTokenOrError = e instanceof Error ? e : new Error(`${e}`);
          }
          errorOrToken[key] = acquiredTokenOrError;
          if (!(acquiredTokenOrError instanceof Error)) {
            retVal = acquiredTokenOrError;
          }
        }
      }

      if (retVal !== null) {
        break;
      }
    }
    if (!retVal) {
      throw new id.CredentialUnavailable(
        "None of the supplied authentication methods managed to acquire token",
      );
    }
    return retVal;
  }

  private checkScopesFromArgs(scopeOrScopes: common.OneOrMore<string>) {
    const scopes =
      typeof scopeOrScopes === "string" ? [scopeOrScopes] : scopeOrScopes;
    const scopeOK = scopes.every((scope) => this.scopes.indexOf(scope) >= 0);
    if (!scopeOK) {
      throw new Error(
        `The given scopes [${scopes
          .map((scope) => `"${scope}"`)
          .join(
            ", ",
          )}] were not fully overlapping with initially provided scopes [${this.scopes
          .map((scope) => `"${scope}"`)
          .join(", ")}].`,
      );
    }
  }
}

interface CredentialInfo {
  credential: common.ItemOrFactory<id.TokenCredential, [ReadonlyArray<string>]>;
  passGivenTokens: boolean;
}

void (async () => {
  try {
    await main();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("ERROR", e);
  }
})();
