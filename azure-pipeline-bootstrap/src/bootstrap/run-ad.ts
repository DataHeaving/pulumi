import * as graph from "@microsoft/microsoft-graph-client";
import * as rest from "@azure/ms-rest-js";
import * as id from "@azure/identity";
import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as common from "@data-heaving/common";
import * as crypto from "crypto";
import * as uuid from "uuid";
import * as types from "./types";
import * as events from "./events";
import * as utils from "./run-common";
import * as certs from "./run-certs";
import { isDeepStrictEqual } from "util";

export interface Inputs {
  eventEmitter: events.BootstrapEventEmitter;
  credentials: id.TokenCredential;
  graphClient: graph.Client;
  bootstrapperApp: {
    displayName: string;
    willNeedToCreateAADApps: boolean;
  };
  certificatePEM: string;
}

export const ensureBootstrapSPIsConfigured = async ({
  eventEmitter,
  credentials,
  graphClient,
  bootstrapperApp: { displayName, willNeedToCreateAADApps },
  certificatePEM,
}: Inputs) => {
  // Ensure that app ("Enterprise Application") exists
  const app = await ensureBootstrapperAppExists(
    eventEmitter,
    graphClient,
    displayName,
  );
  const { appId } = app;

  // Concurrently,
  // - ensure that service principal("App Registration") exists, and
  // - ensure that app has correct certificate-based authentication configured
  // - ensure that app has correct permissions configured
  // Last two items can be done concurrently since PATCH request will not modify same properties.
  const [sp] = await Promise.all([
    ensureBootstrapperSPExists(eventEmitter, graphClient, appId),
    ensureCertificateAuthenticationExists(
      eventEmitter,
      graphClient,
      app,
      certificatePEM,
    ),
    ensureAppHasSufficientPermissions(
      eventEmitter,
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
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  bootstrapperAppName: string,
) => {
  const api = client.api("/applications");
  const existingApp = validation.decodeOrThrow(
    graphAPIResultOf(utils.listOf(types.application)).decode,
    await api.filter(`displayName eq '${bootstrapperAppName}'`).get(),
  ).value[0];
  const application =
    existingApp ??
    validation.decodeOrThrow(
      types.application.decode,
      await api.post({
        displayName: bootstrapperAppName,
      }),
    );
  eventEmitter.emit("afterADApplicationExists", {
    application,
    createNew: !existingApp,
  });
  return application;
};

const ensureBootstrapperSPExists = async (
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  bootstrapperAppId: string,
) => {
  const api = client.api("/servicePrincipals");
  const existingSP = validation.decodeOrThrow(
    graphAPIResultOf(utils.listOf(types.servicePrincipal)).decode,
    await api.filter(`appId eq '${bootstrapperAppId}'`).get(),
  ).value[0];
  const servicePrincipal =
    existingSP ??
    validation.decodeOrThrow(
      types.servicePrincipal.decode,
      await api.post({
        appId: bootstrapperAppId,
      }),
    );
  eventEmitter.emit("afterADServicePrincipalExists", {
    servicePrincipal,
    createNew: !existingSP,
  });
  return servicePrincipal;
};

const ensureCertificateAuthenticationExists = async (
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  application: types.Application,
  certificatePem: string,
) => {
  const { id, keyCredentials } = application;
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
  const createNew = !existingKey;
  const credential: events.CredentialInfo = existingKey ?? {
    type: "AsymmetricX509Cert",
    usage: "Verify",
    keyId: uuid.v4(),
    key: Buffer.from(certificatePem).toString("base64"),
    customKeyIdentifier,
  };
  const waitTimeInSecondsIfCreated = 120; // Sometimes even 60-90sec doesn't work... AAD be ridicilously slow.
  eventEmitter.emit("beforeApplicationCredentialsExists", {
    application,
    credential: Object.fromEntries(
      Object.entries(credential),
    ) as events.CredentialInfo, // This will fail because of bug in @data-heaving/common v1.0.0: common.deepCopy(credential),
    createNew,
    waitTimeInSecondsIfCreated,
  });
  if (createNew) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { customKeyIdentifier: _, ...credentialToPassToApi } = credential;
    // Please notice, the tricky part about /applications/${appId}/addKey, from https://docs.microsoft.com/en-us/graph/api/application-addkey?view=graph-rest-1.0&tabs=javascript
    // "Applications that don’t have any existing valid certificates (no certificates have been added yet, or all certificates have expired), won’t be able to use this service action. You can use the Update application operation to perform an update instead."
    await client.api(`/applications/${id}`).patch({
      keyCredentials: [...keyCredentials, credentialToPassToApi],
    });
    // We must wait some time to let the AAD eventually consistent DB to catch up - if we don't do this, we will get an error when we try to sign in with SP right after this
    await common.sleep(waitTimeInSecondsIfCreated * 1000);
  }
};

const ensureAppHasSufficientPermissions = async (
  eventEmitter: events.BootstrapEventEmitter,
  credentials: id.TokenCredential,
  bootstrapperWillNeedToCreateAADApps: boolean,
  client: graph.Client,
  application: types.Application,
) => {
  // This is currently only needed if app needs to create other apps
  if (bootstrapperWillNeedToCreateAADApps) {
    const { id } = application;
    const patchableAccess = createPatchableRequiredAccessArray(
      application.requiredResourceAccess,
      [
        {
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
        },
      ],
    );
    const createNew = patchableAccess.length > 0;
    const waitTimeInSecondsIfCreated = 60;
    const eventArgsPermissions =
      application.requiredResourceAccess.concat(patchableAccess);
    eventEmitter.emit("beforeApplicationHasEnoughPermissions", {
      application,
      permissions: eventArgsPermissions,
      createNew,
      waitTimeInSecondsIfCreated,
    });

    if (createNew) {
      await client.api(`/applications/${id}`).patch({
        requiredResourceAccess: patchableAccess,
      });
      await common.sleep(waitTimeInSecondsIfCreated * 1000);
    }

    const consentClient = new rest.ServiceClient(
      new rest.AzureIdentityCredentialAdapter(
        credentials,
        types.OAUTH_SCOPE_ADMIN_CONSENT,
      ),
    );
    // Using this will for some reason give "The specified api-version is invalid." error. Also, we probably need to convert resource access GUIDs to strings in dynamicPermissions, which would be a bit PITA.
    // Instead, use the same method as used in Azure CLI
    // const response = await consentClient.sendRequest({
    //   url: "https://graph.windows.net/myorganization/consentToApp",
    //   method: "POST",
    //   queryParameters: {
    //     ["api-version"]: "2.0",
    //   },
    //   body: {
    //     checkOnly: false,
    //     clientAppId: application.appId,
    //     constraintToRra: true,
    //     onBehalfOfAll: true,
    //     tags: [],
    //     dynamicPermissions: [
    //       eventArgsPermissions.map((perm) => ({
    //         appIdentifier: perm.resourceAppId,
    //         scopes: [],
    //         appRoles: perm.resourceAccess.map((a) => a.id),
    //       })),
    //     ],
    //   },
    // });

    const response = await consentClient.sendRequest({
      url: `https://main.iam.ad.ext.azure.com/api/RegisteredApplications/${application.appId}/Consent`,
      method: "POST",
      queryParameters: {
        onBehalfOfAll: "true",
      },
    });
    if (response.status !== 204) {
      throw new Error(
        `Granting admin consent failed: code ${response.status} - "${response.bodyAsText}".`,
      );
    }

    eventEmitter.emit("afterAdminConsentGranted", {
      application,
      permissions: eventArgsPermissions,
    });
  }
};

const createPatchableRequiredAccessArray = (
  existingPermissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>,
  additionalPermissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>,
) => {
  const permissionAddInfos: Array<AppPermissionAddInfo> = [];
  // One can get all possible permissions via https://graph.windows.net/myorganization/applicationRefs/00000003-0000-0000-c000-000000000000?api-version=2.0&lang=en
  // And then examining items in "oauth2Permissions" array
  // Notice!!!! the Pulumi azuread provider uses azure-sdk-for-go, which underneath uses graphrbac, which underneath uses legacy Azure AD Graph endpoint ( https://graph.windows.net/ )!
  // This is why we must, instead of adding Microsoft Graph permissions, add Azure AD Graph permissions!
  for (const additionalPermission of additionalPermissions) {
    addToPatchablePermissions(
      existingPermissions,
      permissionAddInfos,
      additionalPermission,
    );
  }
  const patchableAccess: Array<types.ApplicationRequiredResourceAccess> = [];
  if (permissionAddInfos.length > 0) {
    const deduplicatedAdditionalPermissions = common.deduplicate(
      permissionAddInfos,
      ({ indexToRemove }) => `${indexToRemove}`,
    );
    if (deduplicatedAdditionalPermissions.length < permissionAddInfos.length) {
      throw new Error("Not implemented: complex permission delta");
    }
    patchableAccess.push(...existingPermissions);
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
  }

  return patchableAccess;
};

interface AppPermissionAddInfo {
  indexToRemove: number;
  accessToAdd: types.ApplicationRequiredResourceAccess;
}

const addToPatchablePermissions = (
  existingAccess: ReadonlyArray<types.ApplicationRequiredResourceAccess>,
  accessToAdd: Array<AppPermissionAddInfo>,
  requiredAccess: types.ApplicationRequiredResourceAccess,
) => {
  const existingForResourceAppIdx = existingAccess.findIndex(
    (r) => r.resourceAppId === requiredAccess.resourceAppId,
  );
  const missingAccess =
    existingForResourceAppIdx < 0
      ? []
      : requiredAccess.resourceAccess.filter(
          (r) =>
            !existingAccess[existingForResourceAppIdx].resourceAccess.some(
              (a) => isDeepStrictEqual(r, a),
            ),
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
