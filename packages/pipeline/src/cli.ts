import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { ingestSnapshot } from "./application/ingest-snapshot.js";
import { ingestSource } from "./application/ingest-source.js";
import { ingestTcadExport } from "./application/ingest-tcad-export.js";
import { type IngestWindow, WindowKind } from "./domain/ingest-window.js";
import { runIdAt } from "./domain/run-id.js";
import { SourceId } from "./domain/source-id.js";
import { ArcGisParcelLayer } from "./infrastructure/arcgis-parcel-layer.js";
import { DuckDbFixedWidthTransformer } from "./infrastructure/duckdb-fixed-width-transformer.js";
import { FileArtifactPaths } from "./infrastructure/file-artifact-paths.js";
import { FileRawStore } from "./infrastructure/file-raw-store.js";
import { HttpFileDownloader } from "./infrastructure/http-file-downloader.js";
import { JsonWatermarkStore } from "./infrastructure/json-watermark-store.js";
import { type RetryPolicy, retryingFetch } from "./infrastructure/retrying-fetch.js";
import { SocrataPermitSource } from "./infrastructure/socrata-permit-source.js";
import { TcadExportCatalogPage } from "./infrastructure/tcad-export-catalog-page.js";
import { UnzipMemberExtractor } from "./infrastructure/unzip-member-extractor.js";

const USER_AGENT =
  "travis-oracle-pipeline/0.1 (+https://github.com/curiousily/oracle-property-intelligence-platform-pipeline-travis-tx)";
const AUSTIN_OPEN_DATA_URL = "https://data.austintexas.gov";
const AUSTIN_PERMITS_DATASET_ID = "3syk-w9eu";
const TCAD_PUBLIC_INFORMATION_URL = "https://traviscad.org/publicinformation";
const TCAD_PARCELS_LAYER_URL =
  "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer/0";
const TCAD_PARCELS_OBJECT_ID = "OBJECTID_1";
const TCAD_PARCELS_FIELDS = [TCAD_PARCELS_OBJECT_ID, "PROP_ID", "PID_10", "SITUS", "Shape__Area"];
const ARCGIS_PAGE_SIZE = 2_000;
const SOCRATA_PAGE_SIZE = 50_000;
const RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  maxDelayMs: 120_000,
  attemptTimeoutMs: 300_000,
};
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_DATA_DIR = "data";
const STATE_DIR = "state";
const WORK_DIR = "work";
const INGEST_COMMAND = "ingest";
const USAGE = [
  "usage: cli ingest austin-permits [--since YYYY-MM-DD] [--lookback-days N] [--data-dir DIR] [--run-id ID]",
  "       cli ingest tcad-appraisal-export [--data-dir DIR] [--run-id ID]",
  "       cli ingest tcad-parcels [--data-dir DIR] [--run-id ID]",
].join("\n");

async function main(argv: string[]): Promise<unknown> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      since: { type: "string" },
      "lookback-days": { type: "string", default: String(DEFAULT_LOOKBACK_DAYS) },
      "data-dir": { type: "string", default: DEFAULT_DATA_DIR },
      "run-id": { type: "string" },
    },
  });

  const [command, sourceArg] = positionals;
  if (command !== INGEST_COMMAND) throw new Error(USAGE);

  const dataDir = values["data-dir"];
  const runId = values["run-id"] ?? runIdAt(new Date());
  const watermarks = new JsonWatermarkStore(join(dataDir, STATE_DIR));
  const resilientFetch = retryingFetch(fetch, RETRY_POLICY, (milliseconds) => delay(milliseconds));
  const now = () => new Date();

  switch (sourceArg) {
    case SourceId.AustinPermits: {
      const window: IngestWindow | undefined =
        values.since === undefined ? undefined : { kind: WindowKind.Since, since: values.since };
      return ingestSource(
        {
          source: new SocrataPermitSource({
            baseUrl: AUSTIN_OPEN_DATA_URL,
            datasetId: AUSTIN_PERMITS_DATASET_ID,
            pageSize: SOCRATA_PAGE_SIZE,
            userAgent: USER_AGENT,
            fetch: resilientFetch,
            now,
          }),
          rawStore: new FileRawStore(dataDir),
          watermarks,
        },
        { runId, lookbackDays: Number(values["lookback-days"]), ...(window && { window }) },
      );
    }
    case SourceId.TcadAppraisalExport:
      return ingestTcadExport(
        {
          catalog: new TcadExportCatalogPage({
            pageUrl: TCAD_PUBLIC_INFORMATION_URL,
            userAgent: USER_AGENT,
            fetch: resilientFetch,
          }),
          downloader: new HttpFileDownloader({ userAgent: USER_AGENT, fetch: resilientFetch, now }),
          transformer: new DuckDbFixedWidthTransformer(
            new UnzipMemberExtractor(),
            join(dataDir, WORK_DIR),
          ),
          watermarks,
          paths: new FileArtifactPaths(dataDir),
        },
        { runId },
      );
    case SourceId.TcadParcels:
      return ingestSnapshot(
        {
          layer: new ArcGisParcelLayer({
            layerUrl: TCAD_PARCELS_LAYER_URL,
            objectIdField: TCAD_PARCELS_OBJECT_ID,
            outFields: TCAD_PARCELS_FIELDS,
            pageSize: ARCGIS_PAGE_SIZE,
            userAgent: USER_AGENT,
            fetch: resilientFetch,
            now,
          }),
          rawStore: new FileRawStore(dataDir),
          watermarks,
        },
        { runId },
      );
    default:
      throw new Error(USAGE);
  }
}

main(process.argv.slice(2))
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
