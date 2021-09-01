# Data Heaving - Pulumi Azure Pipeline Setup
[![Code Coverage](https://codecov.io/gh/DataHeaving/pulumi/branch/main/graph/badge.svg?flag=azure-pipeline-setup)](https://codecov.io/gh/DataHeaving/pulumi)

This folder contains source code for `@data-heaving/pulumi-azure-pipeline-setup` NPM package.
The exported entities include:
- Function as default export, which is a Pulumi program, which will set up required infrastructure to run other Pulumi pipelines, which use Azure to store state file and encryption key, and
- Types detailing input and output of the main exported function

The default export function will store the configuration to be used by [@data-heaving/pulumi-azure-pipeline](../azure-pipeline) package when the other Pulumi pipeline will execute.
The type of that configuration is in [@data-heaving/pulumi-azure-pipeline-config](../azure-pipeline-config) package.
The outputs of the function are per-env URIs of the secrets containing JSON-serialized value of the configuration.

# Usage
Include `@data-heaving/pulumi-azure-pipeline-setup` dependency in your `package.json` file.

# More information
To learn more what Data Heaving project is all about, [see here](https://github.com/DataHeaving/orchestration).