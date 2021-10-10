import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as id from "@azure/identity";
import * as graph from "@microsoft/microsoft-graph-client";

export interface BootstrappingCredentials {
  credentials: id.TokenCredential & graph.AuthenticationProvider;
  givenClientId: string | undefined;
}

export type UpsertResult<T> = T & {
  createNew: boolean;
};

export const applicationResourceAccess = t.type(
  {
    type: t.keyof({ Role: null, Scope: null }), // validation.nonEmptyString,
    id: validation.uuid,
  },
  "ResourceAccess",
);

export type ApplicationResourceAccess = t.TypeOf<
  typeof applicationResourceAccess
>;

export const applicationRequiredResourceAccess = t.type(
  {
    resourceAppId: validation.uuid,
    resourceAccess: t.array(applicationResourceAccess, "ResourceAccessList"),
  },
  "RequiredResourceAccess",
);
export type ApplicationRequiredResourceAccess = t.TypeOf<
  typeof applicationRequiredResourceAccess
>;

export const applicationKeyCredential = t.type(
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
);

export type ApplicationCredential = t.TypeOf<typeof applicationKeyCredential>;

export const application = t.type(
  {
    // ["@odata.id"]: validation.urlWithPath,
    id: validation.uuid,
    appId: validation.uuid,
    displayName: t.string,
    keyCredentials: t.array(applicationKeyCredential),
    requiredResourceAccess: t.array(
      applicationRequiredResourceAccess,
      "RequiredResourceAccessList",
    ),
    // And many others (e.g. passwordCredentials, but we don't use that (otherwise same as key credential, but without 'type' and 'usage', and 'hint' and 'secretText' instead ('secretText' and 'customKeyIdentifier' always null)))
  },
  "Application",
);

export type Application = t.TypeOf<typeof application>;

export const servicePrincipal = t.type(
  {
    // ["@odata.id"]: validation.urlWithPath,
    id: validation.uuid,
    appId: validation.uuid,
    displayName: t.string,
    appRoles: t.array(
      t.type(
        {
          id: validation.uuid,
          origin: t.string, // "Application" | ... ?
          value: validation.nonEmptyString,
          description: t.union([t.string, t.null]),
          displayName: t.union([t.string, t.null]),
          // allowedMemberTypes: t.array(t.string) <- "Application" | ...?
        },
        "AppRole",
      ),
      "AppRoleList",
    ),
    // And many others
    // They include also 'keyCredentials', however, that is not used for logging in at least, so we don't touch those here.
  },
  "ServicePrincipal",
);

export type ServicePrincipal = t.TypeOf<typeof servicePrincipal>;

export const servicePrincipalAppRoleAssignment = t.type({
  // ["@odata.id"]: validation.urlWithPath,
  id: validation.nonEmptyString,
  appRoleId: validation.uuid,
  createdDateTime: validation.isoDateString,
  deletedDateTime: t.union([validation.isoDateString, t.null]),
  principalDisplayName: t.string,
  principalId: validation.uuid, // the 'id' field of service principal
  principalType: t.string, // "ServicePrincipal" | ...?
  resourceDisplayName: t.string, // E.g. "Windows Azure Active Directory"
  resourceId: validation.uuid,
});

export type ServicePrincipalAppRoleAssignment = t.TypeOf<
  typeof servicePrincipalAppRoleAssignment
>;
