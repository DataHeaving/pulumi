import test, { ExecutionContext, TestInterface } from "ava";
import * as spec from "..";
import * as common from "@data-heaving/common";
import * as pulumi from "@pulumi/pulumi/automation";
import * as uuid from "uuid";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
interface TestContext {
  stack: pulumi.Stack;
}
const thisTest = test as TestInterface<TestContext>;
thisTest.before(async (t) => {
  const projectName = `UnitTests-${uuid.v4()}`;
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pulumi-automation-tests-"),
  );
  const backendDir = tmpDir;
  const backendURL = `file://${backendDir}`;

  const stack = await pulumi.LocalWorkspace.createStack(
    {
      stackName: uuid.v4(),
      projectName,
      program: pulumiProgram,
    },
    {
      projectSettings: {
        name: projectName,
        runtime: "nodejs",
        backend: {
          url: backendURL,
        },
      },
      envVars: {
        PULUMI_CONFIG_PASSPHRASE: uuid.v4(),
      },
      pulumiHome: `/pulumi-${uuid.v4()}`,
    },
  );
  t.context.stack = stack;
});

thisTest("Stack initialization works successfully for empty plugins", (t) =>
  performTestForPlugins(t, []),
);

thisTest("Stack initialization works successfully for existing plugin", (t) =>
  performTestForPlugins(t, ["random"]),
);

thisTest(
  "Stack initialization throws expected error for non-existing plugin",
  (t) =>
    performTestForPlugins(t, ["tls"], {
      shouldThrow: true,
      getTracker: (seenTracker) => ({
        pluginInstalled: [],
        pluginInstallationError: [
          {
            chronologicalIndex: 0,
            eventArg: seenTracker.pluginInstallationError[0].eventArg,
          },
        ],
      }),
    }),
);

const performTestForPlugins = async (
  t: ExecutionContext<TestContext>,
  plugins: Parameters<typeof spec.initPulumiExecution>[2],
  expectedEventTracker?: {
    shouldThrow: boolean;
    getTracker: (seenTracker: EventTracker) => EventTracker;
  },
) => {
  const { eventEmitter, eventTracker } = createEventEmitterAndRecorder();
  if (expectedEventTracker?.shouldThrow) {
    await t.throwsAsync(
      () => spec.initPulumiExecution(eventEmitter, t.context.stack, plugins),
      {
        instanceOf: spec.PulumiPluginInstallationMultiError,
      },
    );
  } else {
    await spec.initPulumiExecution(eventEmitter, t.context.stack, plugins);
  }
  t.deepEqual(
    eventTracker,
    expectedEventTracker?.getTracker(eventTracker) ?? {
      pluginInstalled: plugins.map((pluginDescription, idx) => ({
        chronologicalIndex:
          eventTracker.pluginInstalled[idx].chronologicalIndex,
        eventArg: {
          pluginInfo:
            spec.getFullPluginPackageInformationFromDescription(
              pluginDescription,
            ),
          version: eventTracker.pluginInstalled[idx].eventArg.version,
        },
      })),
      pluginInstallationError: [],
    },
  );
};

const pulumiProgram = (): Promise<void> => {
  throw new Error("This should never be called");
};
type EventTracker = {
  [E in keyof spec.VirtualEvents]: Array<{
    chronologicalIndex: number;
    eventArg: spec.VirtualEvents[E];
  }>;
};

type CustomEventHandlers = Partial<
  {
    [E in keyof spec.VirtualEvents]: common.EventHandler<spec.VirtualEvents[E]>;
  }
>;

const createEventEmitterAndRecorder = (
  customEventHandlers: CustomEventHandlers = {},
) => {
  const eventBuilder = spec.createEventEmitterBuilder();
  let chronologicalIndex = 0;
  const eventTracker: EventTracker = {
    pluginInstalled: [],
    pluginInstallationError: [],
  };
  for (const evtName of Object.keys(eventTracker)) {
    const eventName = evtName as keyof spec.VirtualEvents;
    eventBuilder.addEventListener(eventName, (eventArg) => {
      eventTracker[eventName].push({
        chronologicalIndex,
        eventArg: eventArg as any, // eslint-disable-line
      });
      ++chronologicalIndex;
    });
    const handler = customEventHandlers[eventName];
    if (handler) {
      eventBuilder.addEventListener(
        eventName,
        handler as common.EventHandler<spec.VirtualEvents[typeof eventName]>,
      );
    }
  }

  return {
    eventEmitter: eventBuilder.createEventEmitter(),
    eventTracker,
  };
};
