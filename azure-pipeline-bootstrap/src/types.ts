import * as pulumiSetup from "@data-heaving/pulumi-azure-pipeline-setup";
import * as bootstrap from "./bootstrap";

export type Organization = bootstrap.OrganizationInfo &
  pulumiSetup.OrganizationInfo;
