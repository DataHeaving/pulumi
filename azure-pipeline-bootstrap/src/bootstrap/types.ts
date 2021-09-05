import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as id from "@azure/identity";
import * as graph from "@microsoft/microsoft-graph-client";

export type BootstrappingCredentials = id.TokenCredential &
  graph.AuthenticationProvider;

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
    ["@odata.id"]: validation.urlWithPath,
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

export const OAUTH_SCOPE_ADMIN_CONSENT =
  "74658136-14ec-4630-ad9b-26e160ff0fc6/.default"; // This UUID corresponds to scope "https://main.iam.ad.ext.azure.com"
