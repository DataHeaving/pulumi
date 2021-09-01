import * as auth from "@azure/core-auth";
import * as common from "./common";

export interface Inputs {
  credentials: auth.TokenCredential;
  subscriptionId: string;
  principalId: string;
}

export const ensureBootstrapSPHasEnoughPrivileges = async ({
  credentials,
  subscriptionId,
  principalId,
}: Inputs) =>
  common.upsertRoleAssignment(
    [credentials, subscriptionId],
    `/subscriptions/${subscriptionId}`,
    // From https://docs.microsoft.com/en-us/azure/role-based-access-control/built-in-roles
    "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", // "Owner"
    principalId,
  );
