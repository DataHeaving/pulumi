import * as pulumiAzure from "@data-heaving/pulumi-azure";
import * as config from "@data-heaving/pulumi-azure-pipeline-config";
import * as uuid from "uuid";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { spawn, ChildProcess } from "child_process";
import { promisify } from "util";
import { pipeline, Readable } from "stream";

const pipelineAsync = promisify(pipeline);

export const configAuthToPulumiAuth = async (
  auth: config.PipelineConfigAuth,
  tempDir?: string,
) => {
  let retVal: pulumiAzure.PulumiAzureBackendAuth;
  let pfx:
    | {
        path: string;
        password: string;
      }
    | undefined;
  switch (auth.type) {
    case "msi":
      retVal = auth;
      break;
    case "sp":
      {
        const pfxPath = path.join(
          tempDir ??
            (await fs.mkdtemp(
              path.join(os.tmpdir(), "pulumi-azure-pipeline-"),
            )),
          `${uuid.v4()}.pfx`,
        );
        const pfxPassword = uuid.v4();
        const pfxPasswordEnvName = "PFX_PASSWORD_ENV";
        const openssl = spawn(
          "openssl",
          [
            "pkcs12",
            "-export",
            "-out",
            pfxPath,
            "-inkey",
            "-",
            "-in",
            "-",
            "-password",
            `env:${pfxPasswordEnvName}`,
          ],
          {
            shell: false,
            env: {
              [pfxPasswordEnvName]: pfxPassword,
            },
            stdio: ["pipe", "inherit", "inherit"], // Make us able to write to stdin, and pass-thru others
          },
        );
        // Pass key + cert via stdin
        await pipelineAsync(
          Readable.from(
            `${ensureEndsWithNewLine(auth.keyPEM)}${ensureEndsWithNewLine(
              auth.certPEM,
            )}`,
          ),
          openssl.stdin,
        );
        await waitOnEndAsync(openssl);
        retVal = {
          type: "sp",
          clientId: auth.clientId,
          backendStorageAccountKey: auth.storageAccountKey,
          pfxPath,
          pfxPassword,
        };
        pfx = {
          path: pfxPath,
          password: pfxPassword,
        };
      }
      break;
  }
  return {
    auth: retVal,
    pfx,
  };
};

const ensureEndsWithNewLine = (str: string) =>
  str.endsWith("\n") ? str : `${str}\n`;

const waitOnEndAsync = (process: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    process.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Process exited with ${code ?? signal}.`));
      }
    });
    process.once("error", (err) => reject(err));
  });
