import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { type BuildResult, buildLeadTables } from "../application/build-lead-tables.js";
import type { BuildInputs } from "../application/lead-build-ports.js";
import { SourceId } from "../domain/source-id.js";
import { DuckDbLeadWarehouse } from "../infrastructure/duckdb-lead-warehouse.js";
import { TABLES_DIR } from "../infrastructure/file-artifact-paths.js";
import { RAW_DIR, RAW_PAGE_GLOB } from "../infrastructure/file-raw-store.js";
import { BBB_ARCHIVE_FILE } from "../infrastructure/ndjson-bbb-archive-store.js";
import { latestRunDir } from "../infrastructure/run-directories.js";
import { BUILD_DIR, BUILD_RESULT_FILE, BUILD_STAGING_DIR } from "./settings.js";

export async function runBuild(
  dataDir: string,
  buildId: string,
  asOf: string,
): Promise<BuildResult> {
  const appraisalTablesDir = await latestRunDir(
    join(dataDir, TABLES_DIR, SourceId.TcadAppraisalExport),
  );
  const parcelRun = await latestRunDir(join(dataDir, RAW_DIR, SourceId.TcadParcels));
  const addressPointRun = await latestRunDir(join(dataDir, RAW_DIR, SourceId.TravisAddressPoints));
  const bbbArchiveDir = join(dataDir, RAW_DIR, SourceId.BbbArchive);
  const hasBbbArchive = (await latestRunDir(bbbArchiveDir)) !== undefined;
  if (appraisalTablesDir === undefined || parcelRun === undefined) {
    throw new Error("build needs an ingested TCAD appraisal export and a TCAD parcel snapshot");
  }

  const buildsDir = join(dataDir, BUILD_DIR);
  const outputDir = join(buildsDir, buildId);
  const stagingDir = join(dataDir, BUILD_STAGING_DIR, buildId);
  await rm(stagingDir, { recursive: true, force: true });
  const inputs: BuildInputs = {
    permitPages: join(dataDir, RAW_DIR, SourceId.AustinPermits, "*", RAW_PAGE_GLOB),
    appraisalTablesDir,
    parcelPages: join(parcelRun, RAW_PAGE_GLOB),
    ...(addressPointRun && { addressPointPages: join(addressPointRun, RAW_PAGE_GLOB) }),
    ...(hasBbbArchive && { bbbProfiles: join(bbbArchiveDir, "*", BBB_ARCHIVE_FILE) }),
  };

  const warehouse = await DuckDbLeadWarehouse.open();
  try {
    const result = await buildLeadTables(warehouse, {
      buildId,
      asOf,
      inputs,
      outputDir: stagingDir,
      previousDir: await latestRunDir(buildsDir, buildId),
    });
    const portable: BuildResult = {
      ...result,
      inputs: {
        permitPages: relative(dataDir, inputs.permitPages),
        appraisalTablesDir: relative(dataDir, inputs.appraisalTablesDir),
        parcelPages: relative(dataDir, inputs.parcelPages),
        ...(inputs.addressPointPages && {
          addressPointPages: relative(dataDir, inputs.addressPointPages),
        }),
        ...(inputs.bbbProfiles && { bbbProfiles: relative(dataDir, inputs.bbbProfiles) }),
      },
    };
    await writeFile(join(stagingDir, BUILD_RESULT_FILE), `${JSON.stringify(portable, null, 2)}\n`);
    await mkdir(buildsDir, { recursive: true });
    await rm(outputDir, { recursive: true, force: true });
    await rename(stagingDir, outputDir);
    return portable;
  } finally {
    warehouse.close();
  }
}
