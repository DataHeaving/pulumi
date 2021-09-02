import * as pulumi from "@pulumi/pulumi/automation";
import * as types from "./types";
import * as events from "./events";

export const runPulumiInfrastructureCommandForStack = <
  TCommand extends types.PulumiCommand,
>(
  eventEmitter: events.RunEventEmitter,
  stack: pulumi.Stack,
  command: TCommand,
): types.PulumiCommandResult<TCommand> => {
  const onOutput = (outputFragment: string) =>
    eventEmitter.emit("pulumiOutput", { outputFragment, command });

  let args: Parameters<pulumi.Stack[TCommand]>;

  // This is not very optimal, but oh well...
  const dummy = <TCommandInner extends types.PulumiCommand>(
    hm: Parameters<pulumi.Stack[TCommandInner]>,
  ) => hm as typeof args;
  switch (command) {
    case "preview":
      args = dummy<"preview">([
        {
          onOutput,
        },
      ]);
      break;
    case "up":
      args = dummy<"up">([
        {
          onOutput,
          diff: true,
        },
      ]);
      break;
    case "destroy":
      args = dummy<"destroy">([
        {
          onOutput,
        },
      ]);
      break;
    default:
      throw new Error(`Unsupported pulumi command: "${command}".`);
  }

  return runPulumiCommandForStack(stack, command, args);
};

export const runPulumiCommandForStack = <
  TCommand extends FunctionNamesOf<pulumi.Stack>,
>(
  stack: pulumi.Stack,
  command: TCommand,
  args: Parameters<pulumi.Stack[TCommand]>,
) => {
  // TS compiler right now can't handle this
  // stack[command].apply<pulumi.Stack, typeof args, types.PulumiCommandResult<TCommand>>(stack, args);
  // eslint-disable-next-line @typescript-eslint/ban-types
  return (stack[command] as Function).apply(stack, args) as ReturnType<
    pulumi.Stack[TCommand]
  >;
};

// TODO put these to data-heaving common
type FunctionKeysOf<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [P in keyof T]: T[P] extends (...any: any) => any ? P : never;
};
type FunctionNamesOf<T> = FunctionKeysOf<T>[keyof T];
