import * as pulumi from "@pulumi/pulumi/automation";

export type PulumiCommandResult<TCommand extends PulumiCommand> = ReturnType<
  pulumi.Stack[TCommand]
>;

export type PulumiCommand = "up" | "preview" | "destroy";
