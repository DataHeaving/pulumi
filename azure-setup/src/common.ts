import * as auth from "@azure/core-auth";
import * as authArm from "@azure/arm-authorization";
import * as t from "io-ts";
import * as validation from "@data-heaving/common-validation";
import * as uuid from "uuid";
import * as common from "./common";

export const listOf = <TType extends t.Mixed>(item: TType) =>
  t.array(item, `${item.name}List`);

export type ClientArgs = readonly [auth.TokenCredential, string];

export const upsertRoleAssignment = async (
  clientOrArgs: ClientArgs | authArm.AuthorizationManagementClient,
  scope: string,
  roleDefinitionUuId: string,
  principalId: string,
) => {
  const client = Array.isArray(clientOrArgs)
    ? new authArm.AuthorizationManagementClient(...clientOrArgs)
    : clientOrArgs;

  const roleDefinitionId = `/subscriptions/${client.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefinitionUuId}`;
  const { roleAssignments } = client;
  return (
    validation
      .decodeOrThrow(
        common.listOf(roleAssignment).decode,
        await roleAssignments.listForScope(scope, {
          // Notice: if you re-run this code quickly in succession, bear in mind that this filter does not immediately see role assignment created on previous run.
          // This will result in "RoleAssignmentExists" error.
          filter: `principalId eq '${principalId}'`, // It would be nice to have " and atScope()" at the end but unfortunately, not supported. I think there will be less results this way as opposed to just atScope()
        }),
      )
      // The array contains also role assignments for anything within the subscription
      .filter(
        (assignment) =>
          assignment.scope === scope &&
          assignment.roleDefinitionId === roleDefinitionId,
      )[0] ??
    (await roleAssignments.create(scope, uuid.v4(), {
      principalId,
      roleDefinitionId,
    }))
  );
};

const roleAssignment = t.type(
  {
    type: t.literal("Microsoft.Authorization/roleAssignments"),
    id: validation.nonEmptyString,
    name: validation.uuid,
    scope: validation.nonEmptyString,
    roleDefinitionId: validation.nonEmptyString,
    principalId: validation.uuid,
    principalType: validation.nonEmptyString, // 'ServicePrincipal'
  },
  "RoleAssignment",
);

// TS is in process of revamping its array methods, see:
// https://github.com/microsoft/TypeScript/issues/17002
// https://github.com/microsoft/TypeScript/pull/41849
// https://github.com/microsoft/TypeScript/issues/36554
// Meanwhile, we need to do with these hacks (code from comment in first link)
declare global {
  interface ArrayConstructor {
    isArray(
      arg: ReadonlyArray<unknown> | unknown,
    ): arg is ReadonlyArray<unknown>;
  }
}
