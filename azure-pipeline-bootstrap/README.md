# Data Heaving - Pulumi Azure Pipeline Bootstrap
[![Code Coverage](https://codecov.io/gh/DataHeaving/pulumi/branch/main/graph/badge.svg?flag=azure-pipeline-bootstrap)](https://codecov.io/gh/DataHeaving/pulumi)

This folder contains source code for `@data-heaving/pulumi-azure-pipeline-bootstrap` NPM package.
The included entities include:
- Function as default export, which will use [Microsoft Graph Client](https://www.npmjs.com/package/@microsoft/microsoft-graph-client) and [various Azure libraries](https://www.npmjs.com/search?q=%40azure) to deploy environment for executing Pulumi, and
- JS file acting as CLI in order to run this bootstrap and then [@data-heaving/pulumi-azure-pipeline-setup](../azure-pipeline-bootstrap) package to finalize required environment for other Pulumi pipeline which will utilize Azure services for its backend.

The exported function will first use native Azure libraries to perform necessary infrastructure setup (to run Pulumi pipeline) in idempotent way, and then invoke Pulumi pipeline which will set up infrastructure for other Pulumi pipelines (e.g. per env: dev/staging/prod etc).
Essentially, this function combines functionality of native Azure libraries and [@data-heaving/pulumi-azure-pipeline-setup](../azure-pipeline-bootstrap) package in order to be able to produce a ready-for-run Azure infrastructure for another Pulumi pipeline from complete scratch, in fully idempotent way.

This package also exports CLI-invokable version.
# Usage
Include `@data-heaving/pulumi-azure-pipeline-bootstrap` dependency in your `package.json` file.

# More information
To learn more what Data Heaving project is all about, [see here](https://github.com/DataHeaving/orchestration).