import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";

export type UpsertResult<T> = T & {
  createNew: boolean;
};

export const applicationRequiredResourceAccess = t.type(
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
export type ApplicationRequiredResourceAccess = t.TypeOf<
  typeof applicationRequiredResourceAccess
>;

export const applicationCredential = t.type(
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

export type ApplicationCredential = t.TypeOf<typeof applicationCredential>;

export const application = t.type(
  {
    ["@odata.id"]: validation.urlWithPath,
    id: validation.uuid,
    appId: validation.uuid,
    displayName: t.string,
    keyCredentials: t.array(applicationCredential),
    requiredResourceAccess: t.array(
      applicationRequiredResourceAccess,
      "RequiredResourceAccessList",
    ),
    // And many others
  },
  "Application",
);

export type Application = t.TypeOf<typeof application>;

export const servicePrincipal = t.type(
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

export type ServicePrincipal = t.TypeOf<typeof servicePrincipal>;
