import * as ad from "@pulumi/azuread";
import * as tls from "@pulumi/tls";
import * as utils from "@data-heaving/common";
import * as types from "./types";

export interface Inputs {
  organization: string;
  envName: string;
  certificateConfig: types.SPCertificateInfo;
  requiredResourceAccesses: ReadonlyArray<types.ApplicationRequiredResourceAccesses>;
}

const createResourcesForSingleEnv = async ({
  organization,
  envName,
  certificateConfig: {
    rsaBits,
    validityHours: certValidityHours,
    subject: certSubject,
  },
  requiredResourceAccesses,
}: Inputs) => {
  const owners = [(await ad.getClientConfig()).objectId];
  const app = new ad.Application(envName, {
    displayName: `${organization}-${envName}-deployer`,
    requiredResourceAccesses: requiredResourceAccesses.map(
      ({ resourceAppId, resourceAccess }) => ({
        resourceAppId,
        resourceAccesses: resourceAccess,
      }),
    ),
    // The owners must be specified explicitly with AzureAD provider version 5+
    // Otherwise e.g. setting app permissions will not work.
    owners,
  });

  const sp = new ad.ServicePrincipal(envName, {
    applicationId: app.applicationId,
    owners,
  });

  const key = new tls.PrivateKey(envName, {
    algorithm: "RSA",
    rsaBits,
  });

  const cert = new tls.SelfSignedCert(envName, {
    privateKeyPem: key.privateKeyPem,
    allowedUses: [],
    keyAlgorithm: key.algorithm,
    subjects: [certSubject],
    validityPeriodHours: certValidityHours,
  });

  new ad.ApplicationCertificate(envName, {
    applicationObjectId: app.id,
    value: cert.certPem,
    type: "AsymmetricX509Cert",
    // Make end date 1 day earlier than cert end date, see here for more details: https://github.com/Azure/azure-powershell/issues/6974
    // Notice that this will most likely be solved after migration to Microsoft Graph API (as azuread provider still uses legacy AAD Graph API).
    // Furthermore, the AAD Graph API silently ignores fractions, causing config drift unless we also do that.
    endDate: cert.validityEndTime.apply((endTime) =>
      removeFractions(
        utils.dateToISOUTCString(
          new Date(new Date(endTime).valueOf() - 1000 * 60 * 60 * 24),
        ),
      ),
    ),
    // usage: "Verify",
  });

  (
    await Promise.all(
      requiredResourceAccesses.map(
        async ({ resourceAppId, resourceAccess }) => ({
          resourceObjectId: (
            await ad.getServicePrincipal({
              applicationId: resourceAppId,
            })
          ).objectId,
          resourceAccess,
        }),
      ),
    )
  ).flatMap(({ resourceObjectId, resourceAccess }) =>
    resourceAccess.map(
      ({ id }) =>
        new ad.AppRoleAssignment(`${envName}-${resourceObjectId}-${id}`, {
          principalObjectId: sp.objectId,
          resourceObjectId,
          appRoleId: id,
        }),
    ),
  );

  return {
    sp,
    key,
    cert,
  };
};

const removeFractions = (dateStr: string) => {
  return dateStr.replace(/\.\d+Z$/, "Z");
};

export default createResourcesForSingleEnv;
