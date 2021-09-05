import * as graph from "@microsoft/microsoft-graph-client";
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
  graphClient: graph.Client;
  bootstrapperApp: {
    displayName: string;
    willNeedToCreateAADApps: boolean;
  };
  certificatePEM: string;
}

export const ensureBootstrapSPIsConfigured = async ({
  eventEmitter,
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
  // - ensure that app has correct permissions configured (if needed)
  // - ensure that app has correct certificate-based authentication configured
  const [sp] = await Promise.all([
    ensureBootstrapperSPExists(eventEmitter, graphClient, appId),
    willNeedToCreateAADApps
      ? grantAppPermissions(eventEmitter, graphClient, app)
      : undefined,
    ensureCertificateAuthenticationExists(
      eventEmitter,
      graphClient,
      app,
      certificatePEM,
    ),
  ]);

  if (willNeedToCreateAADApps) {
    await grantAdminConsent(eventEmitter, graphClient, sp);
  }

  return {
    clientId: appId,
    principalId: sp.id,
  };
};

const appGraphApi = "/applications";
const ensureBootstrapperAppExists = async (
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  bootstrapperAppName: string,
) => {
  // Don't cache result of client.api as it is stateful
  const existingApp = validation.decodeOrThrow(
    graphAPIListOf(types.application).decode,
    await client
      .api(appGraphApi)
      .filter(`displayName eq '${bootstrapperAppName}'`)
      .get(),
  ).value[0];
  const application =
    existingApp ??
    validation.decodeOrThrow(
      types.application.decode,
      await client.api(appGraphApi).post({
        displayName: bootstrapperAppName,
      }),
    );
  eventEmitter.emit("afterADApplicationExists", {
    application,
    createNew: !existingApp,
  });
  return application;
};

const spGraphApi = "/servicePrincipals";
const ensureBootstrapperSPExists = async (
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  bootstrapperAppId: string,
) => {
  const existingSP = await getSPByAppId(client, bootstrapperAppId);
  const servicePrincipal =
    existingSP ??
    validation.decodeOrThrow(
      types.servicePrincipal.decode,
      await client.api(spGraphApi).post({
        appId: bootstrapperAppId,
      }),
    );
  eventEmitter.emit("afterADServicePrincipalExists", {
    servicePrincipal,
    createNew: !existingSP,
  });
  return servicePrincipal;
};

const getSPByAppId = async (
  client: graph.Client,
  appId: string,
): Promise<types.ServicePrincipal | undefined> =>
  validation.decodeOrThrow(
    graphAPIListOf(types.servicePrincipal).decode,
    await client.api(spGraphApi).filter(`appId eq '${appId}'`).get(),
  ).value[0];

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
    await client.api(`${appGraphApi}/${id}`).patch({
      keyCredentials: [...keyCredentials, credentialToPassToApi],
    });
    // We must wait some time to let the AAD eventually consistent DB to catch up - if we don't do this, we will get an error when we try to sign in with SP right after this
    await common.sleep(waitTimeInSecondsIfCreated * 1000);
  }
};

const appRequiredPermissions: Array<types.ApplicationRequiredResourceAccess> = [
  {
    // resourceAppId: "00000003-0000-0000-c000-000000000000", // Microsoft Graph
    // resourceAccess: [
    //   {
    //     type: "Role",
    //     id: "18a4783c-866b-4cc7-a460-3d5e5662c884", // Application.ReadWrite.OwnedBy
    //   },
    // ],
    // We must grant permissions for AAD graph, since Pulumi AAD provider uses that instead of Microsoft Graph
    resourceAppId: "00000002-0000-0000-c000-000000000000", // AAD Graph
    resourceAccess: [
      {
        type: "Role",
        id: "824c81eb-e3f8-4ee6-8f6d-de7f50d565b7", // Application.ReadWrite.OwnedBy
      },
    ],
  },
];

const grantAppPermissions = async (
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  application: types.Application,
) => {
  const { id } = application;
  const patchableAccess = createPatchableRequiredAccessArray(
    application.requiredResourceAccess,
    appRequiredPermissions,
  );
  const createNew = patchableAccess.length > 0;
  const waitTimeInSecondsIfCreated = 60;
  eventEmitter.emit("beforeApplicationHasEnoughPermissions", {
    application,
    permissionsToAssign: patchableAccess,
    createNew,
    waitTimeInSecondsIfCreated,
  });

  if (createNew) {
    await client.api(`${appGraphApi}/${id}`).patch({
      requiredResourceAccess: patchableAccess,
    });
    await common.sleep(waitTimeInSecondsIfCreated * 1000);
  }
};

const getResourceSPMap = async (
  client: graph.Client,
  ids: ReadonlyArray<{ id: string; isSPId: boolean }>,
) =>
  (
    await Promise.all(
      ids.map(async ({ id, isSPId }) =>
        isSPId
          ? validation.decodeOrThrow(
              types.servicePrincipal.decode,
              await client.api(`${spGraphApi}/${id}`).get(),
            )
          : await getSPByAppId(client, id),
      ),
    )
  )
    // .map((sp) => validation.decodeOrThrow(types.servicePrincipal.decode, sp))
    .reduce<Record<string, types.ServicePrincipal>>((curMap, sp, idx) => {
      if (!sp) {
        throw new Error(
          `Could not find service principal: ${JSON.stringify(ids[idx])}.`,
        );
      }
      curMap[sp.appId] = sp; // In case of AAD, the appID will be the "00000002-0000-0000-c000-000000000000" UUID, which also is resourceAppId of types.ApplicationRequiredResourceAccess
      return curMap;
    }, {});

const grantAdminConsent = async (
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  servicePrincipal: types.ServicePrincipal,
) => {
  // We need to find out which permission we need to grant admin consent for
  const spRoleAssignmentsApi = `${spGraphApi}/${servicePrincipal.id}/appRoleAssignments`;
  const adminConsentedRoleAssignments = validation.decodeOrThrow(
    graphAPIListOf(types.servicePrincipalAppRoleAssignment).decode,
    await client.api(spRoleAssignmentsApi).get(),
  ).value;

  // Get target SPs
  const consentedResourceSPs = await getResourceSPMap(
    client,
    common.deduplicate(
      adminConsentedRoleAssignments.map(({ resourceId }) => ({
        id: resourceId,
        isSPId: true,
      })),
      ({ id }) => id,
    ),
  );

  const adminConsentedRoleAssignmentsMap = adminConsentedRoleAssignments.reduce<
    Record<string, Record<string, types.ServicePrincipalAppRoleAssignment>>
  >((curMap, roleAssignment) => {
    common.getOrAddGeneric(curMap, roleAssignment.resourceId, () => ({}))[
      roleAssignment.appRoleId
    ] = roleAssignment;
    return curMap;
  }, {});

  const adminConsentNeededOn = appRequiredPermissions
    .flatMap(({ resourceAppId, resourceAccess }) => {
      const resourceSP = consentedResourceSPs[resourceAppId];
      const missingResources = resourceSP
        ? resourceAccess.filter(
            (access) =>
              !adminConsentedRoleAssignmentsMap[resourceSP.id]?.[access.id],
          )
        : resourceAccess;
      return missingResources.length > 0
        ? { resourceAppId, resourceAccess: missingResources }
        : undefined;
    })
    .filter(
      (
        roleAssignment,
      ): roleAssignment is types.ApplicationRequiredResourceAccess =>
        !!roleAssignment,
    );

  const createNew = adminConsentNeededOn.length > 0;
  eventEmitter.emit("beforeAdminConsentGranted", {
    createNew,
    permissionsToGrant: adminConsentNeededOn,
    servicePrincipal,
  });
  if (createNew) {
    const consentResourceSPs = await getResourceSPMap(
      client,
      adminConsentNeededOn.map(({ resourceAppId }) => ({
        id: resourceAppId,
        isSPId: false,
      })),
    );

    (
      await Promise.all(
        adminConsentNeededOn.flatMap(({ resourceAppId, resourceAccess }) => {
          return resourceAccess.map((resource) => {
            return client.api(spRoleAssignmentsApi).post({
              principalId: servicePrincipal.id,
              resourceId: consentResourceSPs[resourceAppId].id,
              appRoleId: resource.id,
            });
          });
        }),
      )
    ).map((response) =>
      validation.decodeOrThrow(
        types.servicePrincipalAppRoleAssignment.decode,
        response,
      ),
    );
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

const graphAPIListOf = <TType extends t.Mixed>(item: TType) =>
  t.type(
    // Also typically has "@odata.context" attribute but
    {
      value: utils.listOf(item),
    },
    "APIResult",
  );
