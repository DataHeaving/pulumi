# Data Heaving - Pulumi Azure Pipeline Configuration
[![Code Coverage](https://codecov.io/gh/DataHeaving/pulumi/branch/main/graph/badge.svg?flag=azure-pipeline-config)](https://codecov.io/gh/DataHeaving/pulumi)

This folder contains source code for `@data-heaving/pulumi-azure-pipeline-config` NPM package.
The exported entities include:
- Type used by [@data-heaving/pulumi-azure-pipeline-setup](../azure-pipeline-setup) package when writing the contents to Azure Key Vault secret, and used by [@data-heaving/pulumi-azure-pipeline](../azure-pipeline) package when reading the contents from env variable and then running Pulumi.

# Usage
Include `@data-heaving/pulumi-azure-pipeline-config` dependency in your `package.json` file.

# More information
To learn more what Data Heaving project is all about, [see here](https://github.com/DataHeaving/orchestration).