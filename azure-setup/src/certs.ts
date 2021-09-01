import * as fs from "fs/promises";
import * as fsc from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as uuid from "uuid";

const execFileAsync = promisify(execFile);

// This is not safe against concurrent accesses, but I think it's reasonable assumption this bootstrap program is not concurrently run with same inputs
const checkFileExistsAsync = async (path: string) => {
  let exists = false;
  try {
    await fs.access(path, fsc.constants.R_OK);
    exists = true;
  } catch {
    // Ignore
  }
  return exists;
};

export const ensureKeyAndCertExists = async (
  keyPath: string,
  certPath: string,
  rsaBits: number,
  validityPeriodInDays: number,
  certSubject: string,
) => {
  const [keyPathExists, certPathExists] = await Promise.all(
    [keyPath, certPath].map(checkFileExistsAsync),
  );
  const opensslReqKeyArgs: Array<string> = [];
  if (!keyPathExists && !certPathExists) {
    opensslReqKeyArgs.push("-newkey", `rsa:${rsaBits}`, "-keyout", keyPath);
  } else if (keyPathExists !== certPathExists) {
    if (keyPathExists) {
      opensslReqKeyArgs.push("-key", keyPath);
    } else {
      throw new Error("Cert exists but key does not - can not proceed.");
    }
  }

  if (opensslReqKeyArgs.length > 0) {
    await execFileAsync(
      "openssl",
      [
        "req",
        "-x509",
        "-out",
        certPath,
        "-nodes",
        "-days",
        `${validityPeriodInDays}`, // "7000",
        "-subj",
        certSubject, // "/C=FI",
        ...opensslReqKeyArgs,
      ],
      {
        env: {},
        shell: false,
      },
    );
  }
};

export const BEGIN_CERTIFICATE = /(-+BEGIN CERTIFICATE-+)/;

export const ensureCertificateCredentialsFileExists = async (
  tempDir: string,
  keyPath: string,
  certificatePEM: string,
) => {
  const keyAndCertPath = path.join(tempDir, `auth-${uuid.v4()}.pem`);
  const keyPEM = ensureEndsWithNewline(await fs.readFile(keyPath, "utf-8"));
  await fs.writeFile(keyAndCertPath, `${keyPEM}${certificatePEM}`);
  return {
    keyPEM,
    keyAndCertPath,
  };
};

export const ensurePfxExists = async (
  keyPath: string,
  certPath: string,
  pfxPath: string,
  pfxPassword: string,
) => {
  const passwordEnvName = "PFX_PASSWORD";
  if (!(await checkFileExistsAsync(pfxPath))) {
    await execFileAsync(
      "openssl",
      [
        "pkcs12",
        "-export",
        "-inkey",
        keyPath,
        "-in",
        certPath,
        "-out",
        pfxPath,
        "-password",
        `env:${passwordEnvName}`,
      ],
      {
        env: {
          [passwordEnvName]: pfxPassword,
        },
        shell: false,
      },
    );
  }

  return pfxPath;
};

export const ensureEndsWithNewline = (str: string) =>
  str.endsWith("\n") ? str : `${str}\n`;
