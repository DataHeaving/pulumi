import * as ad from "@pulumi/azuread";
import * as tls from "@pulumi/tls";
import * as utils from "@data-heaving/common";

export interface Inputs {
  organization: string;
  envName: string;
  certificateConfig: SPCertificateInfo;
}

export interface SPCertificateInfo {
  rsaBits: number;
  validityHours: number;
  subject: tls.types.input.SelfSignedCertSubject;
}
const createResourcesForSingleEnv = async ({
  organization,
  envName,
  certificateConfig: {
    rsaBits,
    validityHours: certValidityHours,
    subject: certSubject,
  },
}: // eslint-disable-next-line @typescript-eslint/require-await
Inputs) => {
  const app = new ad.Application(envName, {
    displayName: `${organization}-${envName}-deployer`,
  });

  const sp = new ad.ServicePrincipal(envName, {
    applicationId: app.applicationId,
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