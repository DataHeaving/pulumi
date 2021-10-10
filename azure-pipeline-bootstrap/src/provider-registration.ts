// TF has "azurerm_resource_provider_registration" ( https://registry.terraform.io/providers/hashicorp/azurerm/latest/docs/resources/resource_provider_registration )
// Pulumi Azure-Native, however, does not. So let's handle this via custom resources.
import * as pulumi from "@pulumi/pulumi";
import * as pipelineConfig from "@data-heaving/pulumi-azure-pipeline-config";
import * as resources from "@azure/arm-resources";
import * as id from "@azure/identity";

export class ResourceProviderRegistration
  extends pulumi.dynamic.Resource
  implements ResourceOutputs
{
  // Notice the code in https://github.com/pulumi/examples/blob/5bcf9de17a660f17172ca05d4ca3f061456a99c5/azure-ts-static-website/staticWebsite.ts#L68
  // It doesn't work in TS strict mode, and that apparently doesn't bother much the Pulumi devs.
  // This is why we must use the // @ts-expect-error annotation
  // @ts-expect-error assigned by parent class
  public readonly resourceProviderNamespaces: pulumi.Output<
    ReadonlyArray<string>
  >;
  constructor(
    provider: ResourceProviderRegistrationProvider,
    name: string,
    args: ResourceProviderRegistrationOptions,
    opts?: Omit<pulumi.CustomResourceOptions, "provider">,
  ) {
    opts = pulumi.mergeOptions(opts, {
      version: "1.0.0",
    });
    super(provider, `azure-custom:providers:Registrations:${name}`, args, opts);
  }
}

export interface ResourceProviderRegistrationOptions {
  resourceProviderNamespaces: pulumi.Input<ReadonlyArray<string>>;
}

// Transform each property type from pulumi.Input<X> to X
type DynamicProviderInputs = {
  [P in keyof ResourceProviderRegistrationOptions]: ResourceProviderRegistrationOptions[P] extends pulumi.Input<
    infer T
  >
    ? T
    : never;
};

// This resource has identical inputs and outputs.
type DynamicProviderOutputs = DynamicProviderInputs;

// Transform each property type from X to pulumi.Output<X>
type ResourceOutputs = {
  [P in keyof DynamicProviderInputs]: pulumi.Output<DynamicProviderInputs[P]>;
};

export class ResourceProviderRegistrationProvider
  implements pulumi.dynamic.ResourceProvider
{
  public constructor(
    public readonly tenantId: string,
    public readonly subscriptionId: string,
    public readonly auth: pipelineConfig.PipelineConfigAuth,
    public readonly keyAndCertPath: string,
  ) {}

  async create(
    inputs: DynamicProviderInputs,
  ): Promise<pulumi.dynamic.CreateResult> {
    const client = getClient(this);
    await Promise.all(
      inputs.resourceProviderNamespaces.map((resourceProviderNamespace) =>
        client.providers.register(resourceProviderNamespace),
      ),
    );

    return {
      id: getPulumiResourceID(this),
      outs: inputs,
    };
  }

  check(
    olds: DynamicProviderInputs,
    news: DynamicProviderInputs,
  ): Promise<pulumi.dynamic.CheckResult> {
    const failures: Array<pulumi.dynamic.CheckFailure> = [];
    if (news.resourceProviderNamespaces.length <= 0) {
      failures.push({
        property: "resourceProviderNamespaces",
        reason:
          "There must be at least one resource provider namespace specified",
      });
    }
    return Promise.resolve(
      failures.length > 0
        ? {
            failures,
          }
        : {
            inputs: news,
          },
    );
  }

  diff(
    id: string,
    { resourceProviderNamespaces: nsOut }: DynamicProviderOutputs,
    { resourceProviderNamespaces: nsIn }: DynamicProviderInputs,
  ): Promise<pulumi.dynamic.DiffResult> {
    const providersAreSame =
      nsIn.length === nsOut.length &&
      nsIn.every((nsi) =>
        nsOut.some((nso) => nsi.toLowerCase() == nso.toLowerCase()),
      );
    return Promise.resolve({
      // We never replace this resource
      deleteBeforeReplace: false,
      replaces: [],
      changes: !providersAreSame,
    });
  }

  async read(
    id: string,
    currentProps: DynamicProviderOutputs,
  ): Promise<pulumi.dynamic.ReadResult> {
    const providers = await getClient(this).providers.list();
    return {
      id: getPulumiResourceID(this),
      props: {
        resourceProviderNamespaces: providers
          .filter((p) =>
            currentProps.resourceProviderNamespaces.some(
              (ns) => ns.toLowerCase() === p.namespace?.toLowerCase(),
            ),
          )
          .map(({ namespace }) => namespace ?? ""),
      },
    };
  }

  async update(
    id: string,
    currentOutputs: DynamicProviderOutputs,
    newInputs: DynamicProviderInputs,
  ): Promise<pulumi.dynamic.UpdateResult> {
    const providersToAdd = newInputs.resourceProviderNamespaces.filter(
      (nsIn) =>
        !currentOutputs.resourceProviderNamespaces.some(
          (nsOut) => nsIn.toLowerCase() === nsOut.toLowerCase(),
        ),
    );
    const providersToRemove = currentOutputs.resourceProviderNamespaces.filter(
      (nsOut) =>
        !newInputs.resourceProviderNamespaces.some(
          (nsIn) => nsIn.toLowerCase() === nsOut.toLowerCase(),
        ),
    );
    const client = getClient(this);
    await Promise.all([
      ...providersToAdd.map((p) => client.providers.register(p)),
      ...providersToRemove.map((p) => client.providers.unregister(p)),
    ]);
    return {};
  }

  async delete(id: string, props: DynamicProviderOutputs): Promise<void> {
    const client = getClient(this);
    await Promise.all(
      props.resourceProviderNamespaces.map((ns) =>
        client.providers.unregister(ns),
      ),
    );
  }
}

const getPulumiResourceID = ({
  tenantId,
  subscriptionId,
}: ResourceProviderRegistrationProvider) => `${tenantId}/${subscriptionId}`;

const getClient = ({
  subscriptionId,
  ...provider
}: ResourceProviderRegistrationProvider) =>
  new resources.ResourceManagementClient(
    getAzureCredential(provider),
    subscriptionId,
  );

const getAzureCredential = ({
  auth,
  tenantId,
  keyAndCertPath,
}: Pick<
  ResourceProviderRegistrationProvider,
  "auth" | "tenantId" | "keyAndCertPath"
>) => {
  switch (auth.type) {
    case "msi":
      return new id.ManagedIdentityCredential(auth.clientId);
    case "sp": {
      return new id.ClientCertificateCredential(
        tenantId,
        auth.clientId,
        keyAndCertPath,
      );
    }
    default:
      throw new Error(
        `Unsupported auth type "${
          (auth as pipelineConfig.PipelineConfigAuth).type
        }".`,
      );
  }
};
