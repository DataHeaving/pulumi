import * as pulumiSetup from "@data-heaving/pulumi-azure-pipeline-setup";
import * as bootstrap from "./bootstrap";

export type Organization = bootstrap.OrganizationInfo &
  ReplaceProperty<
    pulumiSetup.OrganizationInfo,
    "environments",
    ReadonlyArray<
      pulumiSetup.OrganizationEnvironment &
        EnvironmentSpecificProviderRegistrations
    >
  > &
  OrganizationProviderRegistrations;

// TODO move this to @data-heaving/common
export type ReplaceProperty<T, TProperty extends keyof T, TNewValue> = {
  [P in keyof T]: P extends TProperty ? TNewValue : T[P];
};

export interface OrganizationProviderRegistrations {
  defaultProviderRegistrations?: ProviderRegistrations;
}

export interface EnvironmentSpecificProviderRegistrations {
  providerRegistrations?:
    | ProviderRegistrations
    | {
        ignoreDefaultProviderRegistrations: boolean;
        providerRegistrations: ProviderRegistrations;
      };
}

export type ProviderRegistrations = ReadonlyArray<string>;
