# Data Heaving - Pulumi
[![Code Coverage](https://codecov.io/gh/DataHeaving/pulumi/branch/main/graph/badge.svg)](https://codecov.io/gh/DataHeaving/pulumi)

This repository is part of [Data Heaving project](https://github.com/DataHeaving).
There are multiple packages in the repository, all of which are related to handling infrastructure of cloud data operations with Pulumi:
- [Automation package](automation) to provide helper functions in using generic [Pulumi Automation API](https://www.pulumi.com/docs/guides/automation-api/), and
- [Azure package](azure) to provide helper functions when operating [Pulumi Stacks](https://www.pulumi.com/docs/reference/pkg/nodejs/pulumi/pulumi/automation/#Stack) in Azure Environment (storing state to Azure Storage Account and using key in Azure Key Vault to encrypt secrets).

# Usage
All packages of Data Heaving project are published as NPM packages to public NPM repository under `@data-heaving` organization.

# More information
To learn more what Data Heaving project is all about, [see here](https://github.com/DataHeaving/orchestration).