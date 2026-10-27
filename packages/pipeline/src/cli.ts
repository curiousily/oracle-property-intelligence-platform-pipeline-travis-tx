import { join } from "node:path";
import { parseArgs } from "node:util";
import { ingestSource } from "./application/ingest-source.js";
import { type IngestWindow, WindowKind } from "./domain/ingest-window.js";
import { runIdAt } from "./domain/run-id.js";
import { SourceId } from "./domain/source-id.js";
import { FileRawStore } from "./infrastructure/file-raw-store.js";
import { JsonWatermarkStore } from "./infrastructure/json-watermark-store.js";
import { SocrataPermitSource } from "./infrastructure/socrata-permit-source.js";

const USER_AGENT =
  "travis-oracle-pipeline/0.1 (+https://github.com/curiousily/oracle-property-intelligence-platform-pipeline-travis-tx)";
const AUSTIN_OPEN_DATA_URL = "https://data.austintexas.gov";
const AUSTIN_PERMITS_DATASET_ID = "3syk-w9eu";
const SOCRATA_PAGE_SIZE = 50_000;
const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_DATA_DIR = "data";
const WATERMARKS_FILE = join("state", "watermarks.json");
const INGEST_COMMAND = "ingest";
const USAGE =
  "usage: cli ingest austin-permits [--since YYYY-MM-DD] [--lookback-days N] [--data-dir DIR] [--run-id ID]";

async function main(argv: string[]): Promise<void> {
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
  if (command !== INGEST_COMMAND || sourceArg !== SourceId.AustinPermits) {
    throw new Error(USAGE);
  }

  const dataDir = values["data-dir"];
  const window: IngestWindow | undefined =
    values.since === undefined ? undefined : { kind: WindowKind.Since, since: values.since };

  const result = await ingestSource(
    {
      source: new SocrataPermitSource({
        baseUrl: AUSTIN_OPEN_DATA_URL,
        datasetId: AUSTIN_PERMITS_DATASET_ID,
        pageSize: SOCRATA_PAGE_SIZE,
        userAgent: USER_AGENT,
        fetch,
        now: () => new Date(),
      }),
      rawStore: new FileRawStore(dataDir),
      watermarks: new JsonWatermarkStore(join(dataDir, WATERMARKS_FILE)),
    },
    {
      runId: values["run-id"] ?? runIdAt(new Date()),
      lookbackDays: Number(values["lookback-days"]),
      ...(window && { window }),
    },
  );

  console.log(JSON.stringify(result, null, 2));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
