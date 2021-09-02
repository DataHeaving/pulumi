import * as graph from "@microsoft/microsoft-graph-client";
import * as rest from "@azure/ms-rest-js";
import * as auth from "@azure/core-auth";
import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as utils from "@data-heaving/common";
import * as crypto from "crypto";
import * as uuid from "uuid";
import * as common from "./common";
import * as certs from "./certs";
import { isDeepStrictEqual } from "util";

export interface Inputs {
  credentials: auth.TokenCredential;
  graphClient: graph.Client;
  bootstrapperApp: {
    displayName: string;
    willNeedToCreateAADApps: boolean;
  };
  certificatePEM: string;
}

export const ensureBootstrapSPIsConfigured = async ({
  credentials,
  graphClient,
  bootstrapperApp: { displayName, willNeedToCreateAADApps },
  certificatePEM,
}: Inputs) => {
  // Ensure that app ("Enterprise Application") exists
  const app = await ensureBootstrapperAppExists(graphClient, displayName);
  const { appId } = app;

  // Concurrently,
  // - ensure that service principal("App Registration") exists, and
  // - ensure that app has correct certificate-based authentication configured
  // - ensure that app has correct permissions configured
  const [sp] = await Promise.all([
    ensureBootstrapperSPExists(graphClient, appId),
    ensureCertificateAuthenticationExists(graphClient, app, certificatePEM),
    ensureAppHasSufficientPermissions(
      credentials,
      willNeedToCreateAADApps,
      graphClient,
      app,
    ),
  ]);

  return {
    clientId: appId,
    principalId: sp.id,
  };
};

const ensureBootstrapperAppExists = async (
  client: graph.Client,
  bootstrapperAppName: string,
) => {
  const api = client.api("/applications");
  return (
    validation.decodeOrThrow(
      graphAPIResultOf(common.listOf(application)).decode,
      await api.filter(`displayName eq '${bootstrapperAppName}'`).get(),
    ).value[0] ??
    validation.decodeOrThrow(
      application.decode,
      await api.post({
        displayName: bootstrapperAppName,
      }),
    )
  );
};

const applicationRequiredResourceAccess = t.type(
  {
    resourceAppId: validation.uuid,
    resourceAccess: t.array(
      t.type({
        type: validation.nonEmptyString, // "Role" | something else
        id: validation.uuid,
      }),
      "ResourceAccessList",
    ),
  },
  "RequiredResourceAccess",
);
type ApplicationRequiredResourceAccess = t.TypeOf<
  typeof applicationRequiredResourceAccess
>;

const application = t.type(
  {
    ["@odata.id"]: validation.urlWithPath,
    id: validation.uuid,
    appId: validation.uuid,
    displayName: t.string,
    keyCredentials: t.array(
      t.type(
        {
          customKeyIdentifier: validation.nonEmptyString, // TODO hex string
          displayName: t.string,
          endDateTime: validation.isoDateString,
          key: t.union([t.null, t.string]), // TODO base64 string
          keyId: validation.uuid,
          startDateTime: validation.isoDateString,
          // The following two properties are actually discriminating type union properties, but let's handle that later if needed
          type: t.union([
            t.literal("AsymmetricX509Cert"),
            t.literal("X509CertAndPassword"),
          ]),
          usage: t.union([t.literal("Verify"), t.literal("Sign")]),
        },
        "KeyCredential",
      ),
    ),
    requiredResourceAccess: t.array(
      applicationRequiredResourceAccess,
      "RequiredResourceAccessList",
    ),
    // And many others
  },
  "Application",
);

type Application = t.TypeOf<typeof application>;

const ensureBootstrapperSPExists = async (
  client: graph.Client,
  bootstrapperAppId: string,
) => {
  const api = client.api("/servicePrincipals");
  return (
    validation.decodeOrThrow(
      graphAPIResultOf(common.listOf(servicePrincipal)).decode,
      await api.filter(`appId eq '${bootstrapperAppId}'`).get(),
    ).value[0] ??
    validation.decodeOrThrow(
      servicePrincipal.decode,
      await api.post({
        appId: bootstrapperAppId,
      }),
    )
  );
};

const servicePrincipal = t.type(
  {
    ["@odata.id"]: validation.urlWithPath,
    id: validation.uuid,
    appId: validation.uuid,
    displayName: t.string,
    // And many others
    // They include also 'keyCredentials', however, that is not used for logging in at least, so we don't touch those here.
  },
  "ServicePrincipal",
);

const ensureCertificateAuthenticationExists = async (
  client: graph.Client,
  { id, keyCredentials }: Application,
  certificatePem: string,
) => {
  const certificatePattern = new RegExp(
    `${certs.BEGIN_CERTIFICATE.source}${
      /(\n\r?|\r\n?)([A-Za-z0-9+/\n\r]+=*)(\n\r?|\r\n?)(-+END CERTIFICATE-+)/
        .source
    }`,
  );
  const firstCertBase64 = certificatePattern.exec(certificatePem)?.[3];
  if (!firstCertBase64) {
    throw new Error(
      "Invalid certificate PEM contents, make sure BEGIN CERTIFICATE and END CERTIFICATE pre- and suffixes are present.",
    );
  }

  const customKeyIdentifier = crypto
    .createHash("sha1")
    .update(Buffer.from(firstCertBase64, "base64"))
    .digest("hex")
    .toUpperCase();
  const existingKey = keyCredentials.find(
    (keyCredential) =>
      keyCredential.customKeyIdentifier === customKeyIdentifier,
  );
  if (!existingKey) {
    // Please notice, the tricky part about /applications/${appId}/addKey, from https://docs.microsoft.com/en-us/graph/api/application-addkey?view=graph-rest-1.0&tabs=javascript
    // "Applications that don’t have any existing valid certificates (no certificates have been added yet, or all certificates have expired), won’t be able to use this service action. You can use the Update application operation to perform an update instead."
    const api = client.api(`/applications/${id}`);
    await api.patch({
      keyCredentials: [
        ...keyCredentials,
        {
          type: "AsymmetricX509Cert",
          usage: "Verify",
          keyId: uuid.v4(),
          key: Buffer.from(certificatePem).toString("base64"),
        },
      ],
    });
    // We must wait some time to let the AAD eventually consistent DB to catch up - if we don't do this, we will get an error when we try to sign in with SP right after this
    // eslint-disable-next-line no-console
    console.info(
      "Updated SP certificate auth, waiting 2min before proceeding...",
    );
    await utils.sleep(120 * 1000); // Sometimes even 60-90sec doesn't work... AAD be ridicilously slow.
  }
};

const ensureAppHasSufficientPermissions = async (
  credentials: auth.TokenCredential,
  bootstrapperWillNeedToCreateAADApps: boolean,
  client: graph.Client,
  app: Application,
) => {
  // This is currently only needed if app needs to create other apps
  if (bootstrapperWillNeedToCreateAADApps) {
    const additionalPermissions: Array<AppPermissionAddInfo> = [];
    // One can get all possible permissions via https://graph.windows.net/myorganization/applicationRefs/00000003-0000-0000-c000-000000000000?api-version=2.0&lang=en
    // And then examining items in "oauth2Permissions" array
    // Notice!!!! the Pulumi azuread provider uses azure-sdk-for-go, which underneath uses graphrbac, which underneath uses legacy Azure AD Graph endpoint ( https://graph.windows.net/ )!
    // This is why we must, instead of adding Microsoft Graph permissions, add Azure AD Graph permissions!
    addToPatchablePermissions(app, additionalPermissions, {
      // resourceAppId: "00000003-0000-0000-c000-000000000000", // Microsoft Graph
      // resourceAccess: [
      //   {
      //     type: "Role",
      //     id: "18a4783c-866b-4cc7-a460-3d5e5662c884", // Application.ReadWrite.OwnedBy
      //   },
      // ],
      resourceAppId: "00000002-0000-0000-c000-000000000000", // AAD Graph
      resourceAccess: [
        {
          type: "Role",
          id: "824c81eb-e3f8-4ee6-8f6d-de7f50d565b7", // Application.ReadWrite.OwnedBy
        },
      ],
    });

    const { id } = app;

    if (additionalPermissions.length > 0) {
      const deduplicatedAdditionalPermissions = utils.deduplicate(
        additionalPermissions,
        ({ indexToRemove }) => `${indexToRemove}`,
      );
      if (
        deduplicatedAdditionalPermissions.length < additionalPermissions.length
      ) {
        throw new Error("Not implemented: complex permission delta");
      }
      const patchableAccess = [...app.requiredResourceAccess];
      for (const {
        indexToRemove,
        accessToAdd,
      } of deduplicatedAdditionalPermissions) {
        if (indexToRemove >= 0) {
          patchableAccess[indexToRemove].resourceAccess.concat(
            accessToAdd.resourceAccess,
          );
        } else {
          patchableAccess.push(accessToAdd);
        }
      }

      await client.api(`/applications/${id}`).patch({
        requiredResourceAccess: patchableAccess,
      });

      // eslint-disable-next-line no-console
      console.info(
        "Updated bootstrapper app permissions, waiting 1min before proceeding to allow all Azure internal databases to catch up",
      );
      await utils.sleep(60 * 1000);
    }

    // This is same way as used by Azure CLI
    // Azure Portal uses https://graph.windows.net/myorganization/consentToApp endpoint, but trying getting access token for that and sending request results in error: Authentication_MissingOrMalformed
    //
    // I suspect it is because of JTW token problems:
    // I am not sure how to acquire JWT token, used by Portal, with BOTH:
    // - "aud" claim set to https://graph.windows.net, AND
    // - "scp" claim set to "user_impersonation"
    //
    // Using "az account get-access-token --resource https://graph.windows.net" will result in correct "aud" claim, but incorrect "scp" claim
    // Using "az account get-access-token --resource 74658136-14ec-4630-ad9b-26e160ff0fc6" will result in correct "scp" claim, but incorrect "aud" claim.
    // Therefore, instead of using AAD Graph API, let's use this hidden main.iam.ad.ext.azure.com one.
    const consentClient = new rest.ServiceClient(
      new rest.AzureIdentityCredentialAdapter(
        credentials,
        "74658136-14ec-4630-ad9b-26e160ff0fc6", // This UUID corresponds to scope "https://main.iam.ad.ext.azure.com"
      ),
    );

    const response = await consentClient.sendRequest({
      url: `https://main.iam.ad.ext.azure.com/api/RegisteredApplications/${app.appId}/Consent`, // "https://graph.windows.net/myorganization/consentToApp"
      method: "POST",
      queryParameters: {
        //["api-version"]: "2.0",
        onBehalfOfAll: "true",
      },
      // body: {
      //   checkOnly: true,
      //   clientAppId: app.appId,
      //   constraintToRra: true,
      //   onBehalfOfAll: true,
      //   tags: [],
      //   dynamicPermissions: [],
      // },
    });
    if (response.status !== 204) {
      throw new Error(
        `Granting admin consent failed: code ${response.status} - "${response.bodyAsText}".`,
      );
    }
  }
};

interface AppPermissionAddInfo {
  indexToRemove: number;
  accessToAdd: ApplicationRequiredResourceAccess;
}

const addToPatchablePermissions = (
  app: Application,
  accessToAdd: Array<AppPermissionAddInfo>,
  requiredAccess: ApplicationRequiredResourceAccess,
) => {
  const existingForResourceAppIdx = app.requiredResourceAccess.findIndex(
    (r) => r.resourceAppId === requiredAccess.resourceAppId,
  );
  const missingAccess =
    existingForResourceAppIdx < 0
      ? []
      : requiredAccess.resourceAccess.filter(
          (r) =>
            !app.requiredResourceAccess[
              existingForResourceAppIdx
            ].resourceAccess.some((a) => isDeepStrictEqual(r, a)),
        );
  if (existingForResourceAppIdx < 0 || missingAccess.length > 0) {
    accessToAdd.push({
      indexToRemove: existingForResourceAppIdx,
      accessToAdd:
        existingForResourceAppIdx < 0 ||
        missingAccess.length === requiredAccess.resourceAccess.length
          ? requiredAccess
          : {
              resourceAppId: requiredAccess.resourceAppId,
              resourceAccess:
                requiredAccess.resourceAccess.concat(missingAccess),
            },
    });
  }
};

const graphAPIResultOf = <TType extends t.Mixed>(item: TType) =>
  t.type(
    {
      value: item,
    },
    "APIResult",
  );
