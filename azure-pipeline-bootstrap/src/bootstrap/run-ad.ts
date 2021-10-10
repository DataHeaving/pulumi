import * as graph from "@microsoft/microsoft-graph-client";
import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as pulumi from "@data-heaving/pulumi-azure-pipeline-setup";
import * as common from "@data-heaving/common";
import * as crypto from "crypto";
import * as uuid from "uuid";
import * as types from "./types";
import * as events from "./events";
import * as utils from "./run-common";
import * as certs from "./run-certs";

export interface Inputs {
  eventEmitter: events.BootstrapEventEmitter;
  graphClient: graph.Client;
  bootstrapperApp: {
    displayName: string;
    appRequiredPermissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>;
  };
  certificatePEM: string;
}

export const ensureBootstrapSPIsConfigured = async ({
  eventEmitter,
  graphClient,
  bootstrapperApp: { displayName, appRequiredPermissions },
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
  const willNeedPermissions = appRequiredPermissions.length > 0;
  const [sp] = await Promise.all([
    ensureBootstrapperSPExists(eventEmitter, graphClient, appId),
    willNeedPermissions
      ? grantAppPermissions(
          eventEmitter,
          graphClient,
          app,
          appRequiredPermissions,
        )
      : undefined,
    ensureCertificateAuthenticationExists(
      eventEmitter,
      graphClient,
      app,
      certificatePEM,
    ),
  ]);

  if (willNeedPermissions) {
    await grantAdminConsent(
      eventEmitter,
      graphClient,
      sp,
      appRequiredPermissions,
    );
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
  // TODO fallback to list-owned-objects ( https://docs.microsoft.com/en-us/graph/api/serviceprincipal-list-ownedobjects?view=graph-rest-1.0&tabs=http ) if we get:
  // statusCode: 403,
  // code: 'Authorization_RequestDenied',
  // body: '{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation.","innerError":{"date":"2021-09-11T08:43:56","request-id":"9bf79d05-2480-4e88-afaa-68f0825c969b","client-request-id":"d42c428b-0789-f35e-040a-d8ef199f3296"}}'
  const existingApp = validation.decodeOrThrow(
    graphAPIListOf(types.application).decode,
    await client
      .api(appGraphApi)
      .filter(`displayName eq '${bootstrapperAppName}'`)
      // .header("Accept", "application/json;odata.metadata=full;charset=utf-8") // Use this to include more @odata.xyz properties, if needed. The "IEEE754Compatible" option can also be present, as boolean. ( Basically, setting it to true will make all numbers be serialized as strings: https://docs.microsoft.com/en-us/openspecs/odata_standards/ms-odatajson/e05b68cc-1abc-4c92-86f6-8867e73624f4 ).
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

const grantAppPermissions = async (
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  application: types.Application,
  appRequiredPermissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>,
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
  ).reduce<Record<string, types.ServicePrincipal>>((curMap, sp, idx) => {
    if (!sp) {
      throw new Error(
        `Could not find service principal: ${JSON.stringify(ids[idx])}.`,
      );
    }
    curMap[sp.appId] = sp; // In case of AAD, the appID will be the "00000002-0000-0000-c000-000000000000", which also is resourceAppId of types.ApplicationRequiredResourceAccess
    return curMap;
  }, {});

const grantAdminConsent = async (
  eventEmitter: events.BootstrapEventEmitter,
  client: graph.Client,
  servicePrincipal: types.ServicePrincipal,
  appRequiredPermissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>,
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
  requiredPermissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>,
) => {
  // TODO instead of this mess, just reduce existing and required permissions to Record<string, Array<string>>, and do delta from those data structures instead.
  const existingRecord = getPermissionRecord(existingPermissions);
  const requiredRecord = getPermissionRecord(requiredPermissions);
  const patchableAccess: Array<types.ApplicationRequiredResourceAccess> = [];
  for (const [resourceAppId, requiredAccess] of Object.entries(
    requiredRecord,
  )) {
    const existingResourcePermissions = existingRecord[resourceAppId];
    if (existingResourcePermissions) {
      const requiredKeys = Object.keys(requiredAccess);
      if (requiredKeys.some((k) => !(k in existingResourcePermissions))) {
        patchableAccess.push({
          resourceAppId,
          resourceAccess: common
            .deduplicate(
              requiredKeys.concat(Object.keys(existingResourcePermissions)),
              (id) => id,
            )
            .map((id) => ({
              id,
              type: (existingResourcePermissions[id] ?? requiredAccess[id])
                .type,
            })),
        });
      }
    } else {
      patchableAccess.push({
        resourceAppId,
        resourceAccess: Object.entries(requiredAccess).map(
          ([id, { type }]) => ({ id, type }),
        ),
      });
    }
  }
  if (patchableAccess.length > 0) {
    // We are modifying app permissions -> don't lose existing ones.
    for (const [resourceAppId, existingAccess] of Object.entries(
      existingRecord,
    )) {
      const requiredResourcePermissions = requiredRecord[resourceAppId];
      if (!requiredResourcePermissions) {
        patchableAccess.push({
          resourceAppId,
          resourceAccess: Object.entries(existingAccess).map(
            ([id, { type }]) => ({ id, type }),
          ),
        });
      }
    }
  }

  return patchableAccess;
};

const getPermissionRecord = (
  permissions: ReadonlyArray<types.ApplicationRequiredResourceAccess>,
) =>
  permissions.reduce<
    Record<string, Record<string, Omit<types.ApplicationResourceAccess, "id">>>
  >((r, p) => {
    const currentDic = common.getOrAddGeneric(r, p.resourceAppId, () => ({}));
    for (const { id, ...ra } of p.resourceAccess) {
      // if (id in currentDic && !isDeepStrictEqual(ra, currentDic[id])) {
      //   throw new Error(`Duplicate ID ${id} with different roles.`);
      // }
      currentDic[id] = ra;
    }
    return r;
  }, {});

const graphAPIListOf = <TType extends t.Mixed>(item: TType) =>
  t.type(
    // Also typically has "@odata.context" attribute but
    {
      value: utils.listOf(item),
    },
    "APIResult",
  );

const graphSelf = t.type(
  {
    // ["@odata.context"]: t.literal(
    //   "https://graph.microsoft.com/v1.0/$metadata#users/$entity"
    // ),
    // ["@odata.id"]: validation.urlWithPath,
    // businessPhones: [],
    // displayName: validation.nonEmptyString,
    // givenName: validation.nonEmptyString,
    // jobTitle: null,
    // mail: null,
    // mobilePhone: null,
    // officeLocation: null,
    // preferredLanguage: validation.nonEmptyString,
    // surname: validation.nonEmptyString,
    // userPrincipalName: validation.nonEmptyString,
    id: validation.uuid,
  },
  "GraphUser",
);

export const getCurrentPrincipalInfo = async (
  graphClient: graph.Client,
  givenClientId: string | undefined,
): Promise<pulumi.EnvSpecificPipelineConfigReader> => {
  // TODO handle situations when client ID is given but it is not actually used
  if (givenClientId) {
    const id = validation.decodeOrThrow(
      graphAPIListOf(types.servicePrincipal).decode,
      await graphClient
        .api(`${spGraphApi}`)
        .filter(`appId eq '${givenClientId}'`)
        .get(),
    ).value[0]?.id;
    if (!id) {
      throw new Error(
        `Could not find corresponding SP for client ID ${givenClientId}.`,
      );
    }
    return {
      principalId: id,
      principalType: "ServicePrincipal",
    };
  } else {
    return {
      principalId: validation.decodeOrThrow(
        graphSelf.decode,
        await graphClient.api("/me").get(),
      ).id,
      principalType: "User",
    };
  }
};
