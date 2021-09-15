import * as pulumi from "@pulumi/pulumi/automation";
import * as spec from "..";
import test from "ava";

test("Compile-time test", (t) => {
  t.assert(true, "The real test happened at compile-time");
});

const compileTimeTest = async (): Promise<pulumi.UpResult> => {
  const result = await spec.runPulumiPipeline(null!, [], ["up"], null!);
  return result[0];
};

// I'm not sure how to do this one
// const compileTimeTest2 = async (): Promise<
//   [pulumi.RefreshResult, pulumi.UpResult]
// > => {
//   const result = await spec.runPulumiPipeline(
//     null!,
//     [],
//     ["refresh", "up"],
//     null!,
//   );
//   return result;
// };
