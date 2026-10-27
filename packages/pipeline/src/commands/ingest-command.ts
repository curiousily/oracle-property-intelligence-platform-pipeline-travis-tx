import { join } from "node:path";
import { ingestSnapshot } from "../application/ingest-snapshot.js";
import { ingestSource } from "../application/ingest-source.js";
import { ingestTcadExport } from "../application/ingest-tcad-export.js";
import { type IngestWindow, WindowKind } from "../domain/ingest-window.js";
import { SourceId } from "../domain/source-id.js";
import { ArcGisParcelLayer } from "../infrastructure/arcgis-parcel-layer.js";
import { DuckDbFixedWidthTransformer } from "../infrastructure/duckdb-fixed-width-transformer.js";
import { FileArtifactPaths } from "../infrastructure/file-artifact-paths.js";
import { FileRawStore } from "../infrastructure/file-raw-store.js";
import { HttpFileDownloader } from "../infrastructure/http-file-downloader.js";
import { JsonWatermarkStore } from "../infrastructure/json-watermark-store.js";
import { SocrataPermitSource } from "../infrastructure/socrata-permit-source.js";
import { TcadExportCatalogPage } from "../infrastructure/tcad-export-catalog-page.js";
import { UnzipMemberExtractor } from "../infrastructure/unzip-member-extractor.js";
import { resilientFetch, STATE_DIR, USER_AGENT, WORK_DIR } from "./settings.js";

const AUSTIN_OPEN_DATA_URL = "https://data.austintexas.gov";
const AUSTIN_PERMITS_DATASET_ID = "3syk-w9eu";
const TCAD_PUBLIC_INFORMATION_URL = "https://traviscad.org/publicinformation";
const TCAD_PARCELS_LAYER_URL =
  "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer/0";
const TCAD_PARCELS_OBJECT_ID = "OBJECTID_1";
const TCAD_PARCELS_FIELDS = [TCAD_PARCELS_OBJECT_ID, "PROP_ID", "PID_10", "SITUS", "Shape__Area"];
const ARCGIS_PAGE_SIZE = 2_000;
const SOCRATA_PAGE_SIZE = 50_000;

export interface IngestCommandOptions {
  dataDir: string;
  runId: string;
  lookbackDays: number;
  since: string | undefined;
}

export function isSourceId(value: string | undefined): value is SourceId {
  return Object.values(SourceId).includes(value as SourceId);
}

export async function runIngest(
  source: SourceId,
  { dataDir, runId, lookbackDays, since }: IngestCommandOptions,
): Promise<unknown> {
  const watermarks = new JsonWatermarkStore(join(dataDir, STATE_DIR));
  const now = () => new Date();

  switch (source) {
    case SourceId.AustinPermits: {
      const window: IngestWindow | undefined =
        since === undefined ? undefined : { kind: WindowKind.Since, since };
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
        { runId, lookbackDays, ...(window && { window }) },
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
  }
}
