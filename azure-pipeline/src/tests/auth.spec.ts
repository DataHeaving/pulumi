import test from "ava";
import * as config from "@data-heaving/pulumi-azure-pipeline-config";
import * as uuid from "uuid";
import { execFile } from "child_process";
import { promisify } from "util";
import * as spec from "../auth";

const execFileAsync = promisify(execFile);

test("Ensure PFX generation works", async (t) => {
  // Generate key + cert
  const { keyPEM, certPEM } = await generateSPKeyAndCert();
  // Create pfx
  const { pfx } = await spec.configAuthToPulumiAuth({
    type: "sp",
    clientId: uuid.v4(),
    storageAccountKey: "will be ignored",
    keyPEM,
    certPEM,
  });
  // Make sure pfx path has been exposed
  t.notDeepEqual(pfx, undefined);

  // Make sure pfx is correct
  const pwEnvName = "THE_PASSWORD";
  const keyAndCert = (
    await execFileAsync(
      "openssl",
      [
        "pkcs12",
        "-in",
        pfx!.path, // eslint-disable-line @typescript-eslint/no-non-null-assertion
        "-out",
        "-",
        "-nodes",
        "-password",
        `env:${pwEnvName}`,
      ],
      {
        env: {
          [pwEnvName]: pfx!.password, // eslint-disable-line @typescript-eslint/no-non-null-assertion
        },
        shell: false,
      },
    )
  ).stdout;
  t.true(keyAndCert.indexOf(keyPEM) >= 0);
  t.true(keyAndCert.indexOf(certPEM) >= 0);
});

test("Ensure PFX is not generated for MSI authentication", async (t) => {
  const { pfx } = await spec.configAuthToPulumiAuth({
    type: "msi",
    clientId: uuid.v4(),
    resourceId: "not-used",
  });
  t.deepEqual(pfx, undefined);
});

test("Ensure auth types remain the same after conversion", async (t) => {
  const [msiAuth, spAuth] = await Promise.all(
    new Array<config.PipelineConfigAuth>(
      {
        type: "msi",
        clientId: uuid.v4(),
        resourceId: "not-used",
      },
      {
        type: "sp",
        clientId: uuid.v4(),
        storageAccountKey: "not-used",
        ...(await generateSPKeyAndCert()),
      },
    ).map((auth) => spec.configAuthToPulumiAuth(auth)),
  );
  t.deepEqual(msiAuth.auth.type, "msi");
  t.deepEqual(spAuth.auth.type, "sp");
});

const generateSPKeyAndCert = async () => {
  // 1. Generate key + cert
  const keyAndCert = (
    await execFileAsync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        `rsa:4096`,
        "-keyout",
        "-", // stdout
        "-out",
        "-",
        "-nodes",
        "-days",
        "1000",
        "-subj",
        "/O=Organization",
      ],
      {
        shell: false,
      },
    )
  ).stdout;
  const certStart = keyAndCert.indexOf("-----BEGIN CERTIFICATE-----");

  // Generate pfx
  const keyPEM = keyAndCert.substr(0, certStart);
  const certPEM = keyAndCert.substr(certStart);
  return {
    keyPEM,
    certPEM,
  };
};
