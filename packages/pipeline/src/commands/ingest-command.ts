import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ingestBbbArchive } from "../application/ingest-bbb-archive.js";
import { ingestSnapshot } from "../application/ingest-snapshot.js";
import { ingestSource } from "../application/ingest-source.js";
import { ingestTcadExport } from "../application/ingest-tcad-export.js";
import { type IngestWindow, WindowKind } from "../domain/ingest-window.js";
import { SourceId } from "../domain/source-id.js";
import { ArcGisFeatureLayer, FeatureGeometry } from "../infrastructure/arcgis-feature-layer.js";
import { BbbStateParser } from "../infrastructure/bbb-state-parser.js";
import { DuckDbFixedWidthTransformer } from "../infrastructure/duckdb-fixed-width-transformer.js";
import { FileArtifactPaths } from "../infrastructure/file-artifact-paths.js";
import { FileRawStore } from "../infrastructure/file-raw-store.js";
import { HttpFileDownloader } from "../infrastructure/http-file-downloader.js";
import { JsonWatermarkStore } from "../infrastructure/json-watermark-store.js";
import { NdjsonBbbArchiveStore } from "../infrastructure/ndjson-bbb-archive-store.js";
import { SocrataPermitSource } from "../infrastructure/socrata-permit-source.js";
import { TcadExportCatalogPage } from "../infrastructure/tcad-export-catalog-page.js";
import { UnzipMemberExtractor } from "../infrastructure/unzip-member-extractor.js";
import { WaybackCdxIndex, WaybackSnapshotFetcher } from "../infrastructure/wayback.js";
import { resilientFetch, STATE_DIR, USER_AGENT, WORK_DIR } from "./settings.js";

const AUSTIN_OPEN_DATA_URL = "https://data.austintexas.gov";
const AUSTIN_PERMITS_DATASET_ID = "3syk-w9eu";
const TCAD_PUBLIC_INFORMATION_URL = "https://traviscad.org/publicinformation";
const TCAD_PARCELS_LAYER_URL =
  "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer/0";
const TCAD_PARCELS_OBJECT_ID = "OBJECTID_1";
const TCAD_PARCELS_FIELDS = [TCAD_PARCELS_OBJECT_ID, "PROP_ID", "PID_10", "SITUS", "Shape__Area"];
const TRAVIS_ADDRESS_POINTS_LAYER_URL =
  "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/LOCATION_address_points/FeatureServer/0";
const TRAVIS_ADDRESS_POINTS_OBJECT_ID = "OBJECTID";
const TRAVIS_ADDRESS_POINTS_FIELDS = [
  TRAVIS_ADDRESS_POINTS_OBJECT_ID,
  "ADDRESS",
  "ADDRESS_FRACTION",
  "PREFIX_DIRECTION",
  "PREFIX_TYPE",
  "STREET_NAME",
  "STREET_TYPE",
  "SUFFIX_DIRECTION",
  "ADDRESS_SUFFIX",
  "FULL_STREET_NAME",
];
const BBB_STATE = "tx";
const BBB_CATEGORIES = [
  "roofing-contractors",
  "general-contractor",
  "home-builders",
  "siding-contractors",
];
const WAYBACK_REQUEST_INTERVAL_MS = 1_000;
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
          layer: new ArcGisFeatureLayer({
            id: SourceId.TcadParcels,
            geometry: FeatureGeometry.Centroid,
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
    case SourceId.TravisAddressPoints:
      return ingestSnapshot(
        {
          layer: new ArcGisFeatureLayer({
            id: SourceId.TravisAddressPoints,
            geometry: FeatureGeometry.Point,
            layerUrl: TRAVIS_ADDRESS_POINTS_LAYER_URL,
            objectIdField: TRAVIS_ADDRESS_POINTS_OBJECT_ID,
            outFields: TRAVIS_ADDRESS_POINTS_FIELDS,
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
    case SourceId.BbbArchive:
      return ingestBbbArchive(
        {
          index: new WaybackCdxIndex({ userAgent: USER_AGENT, fetch: resilientFetch }),
          snapshots: new WaybackSnapshotFetcher({
            userAgent: USER_AGENT,
            minIntervalMs: WAYBACK_REQUEST_INTERVAL_MS,
            fetch: resilientFetch,
            sleep: (milliseconds) => delay(milliseconds),
            now,
          }),
          parser: new BbbStateParser(),
          store: new NdjsonBbbArchiveStore(dataDir),
          watermarks,
        },
        { runId, state: BBB_STATE, categories: BBB_CATEGORIES },
      );
  }
}
