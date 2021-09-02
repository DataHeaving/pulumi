import test from "ava";
import * as uuid from "uuid";
import { execFile } from "child_process";
import { promisify } from "util";
import * as spec from "../auth";

const execFileAsync = promisify(execFile);

test("Ensure PFX generation works", async (t) => {
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
  const keyAndCertFromPfx = (
    await execFileAsync(
      "openssl",
      [
        "pkcs12",
        "-in",
        pfx!.path,
        "-out",
        "-",
        "-nodes",
        "-password",
        `env:${pwEnvName}`,
      ],
      {
        env: {
          [pwEnvName]: pfx!.password,
        },
        shell: false,
      },
    )
  ).stdout;
  t.true(keyAndCertFromPfx.indexOf(keyPEM) >= 0);
  t.true(keyAndCertFromPfx.indexOf(certPEM) >= 0);
});
