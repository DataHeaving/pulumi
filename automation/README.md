# Data Heaving - Pipelines Orchestration
[![Code Coverage](https://codecov.io/gh/DataHeaving/orchestration/branch/develop/graph/badge.svg?flag=pipelines)](https://codecov.io/gh/DataHeaving/orchestration)

This folder contains source code for `@data-heaving/orchestration` NPM package.
The exported entities include:
- `DataPipelineBuilder` class to incrementally and declaratively build your data pipelines,
- `from` utility method to more easily create instances of generic `DataPipelineBuilder` class, and
- `DataPipeline` class to finalize the pipeline or continue with another pipeline after a syncing point (load result of previous pipeline into memory, do something to it, and continue with another pipeline).

# Usage
Include `@data-heaving/orchestration` dependency in your `package.json` file.

# More information
Here is one example of defining a pipeline which will read data from SQL Server table (using full read, to keep this first example simple), transform the data to GZIPped CSV, and store it to Azure BLOB storage, while splitting it to approximately max 150MB chunks:

```ts
import * as blob from "@azure/storage-blob";
import { from } from "@data-heaving/orchestration";
import * as mssqlSource from "@data-heaving/source-sql-mssql";
import csvTransform from "@data-heaving/transform-csv";
import gzipTransform from "@data-heaving/transform-gzip";
import * as blobSink from "@data-heaving/sink-azure-blob";
import * as azureCommon from "@data-heaving/common-azure";
import * as events from "./events";

// Prepare pipeline elements
const sqlPool = mssqlSource.getMSSQLPool(...); // Pool of connections to SQL server, this example will only use 1 connection though
const auth = azureCommon.getEnvOrManagedIDAuth(); // Azure Authentication functionality
const ctStorage = new blob.ContainerClient('url-to-storage-container', auth); // Where to store change tracking information for the table
const eventBuilder = events.createMyEventBuilder(); // See below for more info
// Set up event builder with listeners here, before
const eventEmitter = eventBuilder.createEventEmitter();

// Define the pipeline
const pipeline = from(
  mssqlSource.rowsInTable(sqlPool)
    .fullLoad(eventEmitter)
  ))
  // Transform SQL rows to CSV rows (strings), without header as we don't get table metadata as context
  .simpleTransformEveryDatum(
    csvTransform(),
  )
  // Compress CSV rows (strings) using GZIP
  .complexTransformEveryDatum(gzipTransform())
  // And store them to Azure BLOB storage, splitting to approximately 150MB size each (as optimal for Snowflake ingestion)
  .storeTo(
    blobSink.toAzureBlobStorage({
      getBlobID: ({ tableID, tableProcessingStartTime }) =>
      // Construct folder path by using just table name + load time
        `${azureCommon.sanitizeForBlobPath(
          tableID.tableName,
        )}/${tableProcessingStartTime}`,
      blobClientFactory: (blobID, existingCount) => ({
        maxSizeInKB: 150 * 1024, // Approximate max single compressed file size: 150MB
        client: dataClient.getBlockBlobClient(
          `${blobID}/data-${existingCount}.csv.gz`, // Individual files within the folder will be data-0.csv.gz, data-1.csv.gz, etc.
        ),
      }),
      eventEmitter,
    }),
  )
  .finalizePipeline();

// Invoke the pipeline
await pipeline({
  databaseName: 'myDB',
  schemaName: 'mySchema',
  tableName: 'myTable'
});
```

It is possible to do incremental loads as well, but examples about this within this README file will be visible later.