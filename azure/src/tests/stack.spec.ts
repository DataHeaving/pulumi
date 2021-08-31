import test from "ava";
import * as spec from "..";
import * as uuid from "uuid";

test("Test that Azure provider env vars are deduced correctly", (t) => {
  const runTestForArgs = (
    args: spec.PulumiAzureBackendStackAcquiringConfig,
  ) => {
    const azureProviderEnv = spec.getAzureProviderEnvVars(args);
    const expectedEnv: Record<string, string> = {
      ARM_TENANT_ID: args.azure.tenantId,
      ARM_DISABLE_PULUMI_PARTNER_ID: "true",
    };
    if (args.azure.subscriptionId) {
      expectedEnv.ARM_SUBSCRIPTION_ID = args.azure.subscriptionId;
    }
    const { auth } = args.pulumi;
    switch (auth.type) {
      case "msi":
        {
          expectedEnv.ARM_CLIENT_ID = auth.clientId;
          expectedEnv.ARM_USE_MSI = "true";
        }
        break;
      case "sp":
        {
          expectedEnv.ARM_CLIENT_ID = auth.clientId;
          expectedEnv.ARM_CLIENT_CERTIFICATE_PATH = auth.pfxPath;
          expectedEnv.ARM_CLIENT_CERTIFICATE_PASSWORD = auth.pfxPassword ?? "";
        }
        break;
    }
    t.deepEqual(azureProviderEnv, expectedEnv);
  };

  const runTestForAuth = (auth: spec.PulumiAzureBackendAuth) => {
    runTestForArgs(makeArgs(auth, true, false));
    runTestForArgs(makeArgs(auth, false, false));
  };
  runTestForAuth({
    type: "msi",
    clientId: uuid.v4(),
  });
  runTestForAuth({
    type: "sp",
    clientId: uuid.v4(),
    backendStorageAccountKey: uuid.v4(),
    pfxPath: uuid.v4(),
  });
});

test("Test that Azure backend local workspace settings are created correctly", (t) => {
  const runTestForArgs = (
    args: spec.PulumiAzureBackendStackAcquiringConfig,
  ) => {
    const opts = spec.createLocalWorkspaceOptionsForStackWithAzureBackend(args);
    const envVars: Record<string, string> = {
      AZURE_TENANT_ID: args.azure.tenantId,
      AZURE_STORAGE_ACCOUNT: args.pulumi.backendConfig.storageAccountName,
    };
    const { auth } = args.pulumi;
    switch (auth.type) {
      case "msi":
        envVars.AZURE_CLIENT_ID = auth.clientId;
        break;
      case "sp":
        {
          envVars.AZURE_CLIENT_ID = auth.clientId;
          envVars.AZURE_CERTIFICATE_PATH = auth.pfxPath;
          envVars.AZURE_CERTIFICATE_PASSWORD = auth.pfxPassword ?? "";
          envVars.AZURE_STORAGE_KEY = auth.backendStorageAccountKey;
        }
        break;
    }
    t.deepEqual(opts, {
      envVars,
      secretsProvider: args.pulumi.backendConfig.encryptionKeyURL,
      stackSettings: {
        [args.pulumi.programArgs.stackName]: {
          secretsProvider: args.pulumi.backendConfig.encryptionKeyURL,
        },
      },
      projectSettings: {
        name: args.pulumi.programArgs.projectName,
        runtime: "nodejs",
        backend: {
          url: `azblob://${args.pulumi.backendConfig.storageContainerName}`,
        },
      },
    });
  };
  const runTestForAuth = (auth: spec.PulumiAzureBackendAuth) => {
    runTestForArgs(makeArgs(auth, true, true));
    runTestForArgs(makeArgs(auth, false, true));
  };
  runTestForAuth({
    type: "msi",
    clientId: uuid.v4(),
  });
  runTestForAuth({
    type: "sp",
    clientId: uuid.v4(),
    backendStorageAccountKey: uuid.v4(),
    pfxPath: uuid.v4(),
  });
});

const makeArgs = (
  auth: spec.PulumiAzureBackendAuth,
  addSub: boolean,
  skipAzureProviderEnv: boolean,
): spec.PulumiAzureBackendStackAcquiringConfig => {
  const retVal: spec.PulumiAzureBackendStackAcquiringConfig = {
    pulumi: {
      auth,
      backendConfig: {
        storageAccountName: uuid.v4(),
        storageContainerName: uuid.v4(),
        encryptionKeyURL:
          "azurekeyvault://vault-name.vault.azure.net/keys/some-key",
      },
      programArgs: {
        projectName: uuid.v4(),
        stackName: uuid.v4(),
        program: pulumiProgram,
      },
      processEnvVars: skipAzureProviderEnv ? (envVars) => envVars : undefined,
    },
    azure: {
      tenantId: uuid.v4(),
    },
  };
  if (addSub) {
    retVal.azure.subscriptionId = uuid.v4();
  }
  return retVal;
};

const pulumiProgram = () => {
  throw new Error("This should never be called");
};
