import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { DuckDBInstance } from "@duckdb/node-api";
import { beforeAll, describe, expect, it } from "vitest";
import { type BuildResult, buildLeadTables } from "../../src/application/build-lead-tables.js";
import type { BuildInputs } from "../../src/application/lead-build-ports.js";
import { DuckDbLeadWarehouse } from "../../src/infrastructure/duckdb-lead-warehouse.js";

const AS_OF = "2026-10-27";
const OLDER_RUN = "20261026T000000Z";
const LATEST_RUN = "20261027T000000Z";
const APPRAISAL_RUN = "20261027T100000Z";
const PARCEL_RUN = "20261027T110000Z";

type Row = Record<string, unknown>;

const permit = (fields: Row): Row => ({
  permittype: "BP",
  work_class: "Remodel",
  permit_class: "R- 434 Addition & Alterations",
  link: { url: `https://abc.austintexas.gov/permit/${fields.permit_number}` },
  ...fields,
});

const RELIABLE = {
  contractor_company_name: "RELIABLE ROOFING OF TEXAS INC",
  contractor_phone: "(512) 555-0142",
};

const OLDER_PERMITS = [
  permit({
    permit_number: "2010-000002 BP",
    description: "Re-roof residence",
    status_current: "Final",
    issue_date: "2010-09-01T00:00:00.000",
    completed_date: "2010-10-28T00:00:00.000",
    tcad_id: "0100000001",
    latitude: "30.2601",
    longitude: "-97.7501",
    ...RELIABLE,
  }),
  permit({
    permit_number: "2016-023376 BP",
    description: "Replace roof shingles on sf res.",
    status_current: "Active",
    issue_date: "2016-03-03T00:00:00.000",
    tcad_id: "0100000001",
    contractor_company_name: "Reliable Roofing, Inc.",
  }),
];

const LATEST_PERMITS = [
  permit({
    permit_number: "2016-023376 BP",
    description: "Replace roof shingles on sf res.",
    status_current: "Expired",
    applieddate: "2016-03-01T00:00:00.000",
    issue_date: "2016-03-03T00:00:00.000",
    expiresdate: "2017-01-02T00:00:00.000",
    tcad_id: "0100000001",
    contractor_company_name: "Reliable Roofing, Inc.",
  }),
  permit({
    permit_number: "2020-000005 BP",
    description: "Re-roof",
    status_current: "Active",
    issue_date: "2020-05-05T00:00:00.000",
    tcad_id: "0100000003",
    latitude: "30.3001",
    longitude: "-97.6001",
  }),
  permit({
    permit_number: "2021-000006 EP",
    permittype: "EP",
    description: "Re-roof residence",
    status_current: "Active",
    tcad_id: "0100000001",
  }),
  permit({
    permit_number: "2022-000007 BP",
    description: "Kitchen remodel",
    status_current: "Final",
    tcad_id: "0100000002",
  }),
  permit({
    permit_number: "2001-000009 BP",
    work_class: "New",
    permit_class: "R- 101 Single Family Houses",
    description: "New single family residence",
    status_current: "Final",
    completed_date: "2001-06-01T00:00:00.000",
    tcad_id: "0100000002",
  }),
];

const parcelPage = (features: Row[]) => ({ features, exceededTransferLimit: false });
const PARCELS = parcelPage([
  {
    attributes: { PROP_ID: 100008, PID_10: "0100000001", Shape__Area: 50 },
    centroid: { x: -97.0, y: 30.0 },
  },
  {
    attributes: { PROP_ID: 100008, PID_10: "0100000001", Shape__Area: 9000 },
    centroid: { x: -97.75, y: 30.26 },
  },
  {
    attributes: { PROP_ID: 100012, PID_10: "0100000002", Shape__Area: 7000 },
    centroid: { x: -97.7, y: 30.3 },
  },
]);

async function writeGzipJson(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, gzipSync(JSON.stringify(value)));
}

async function writeAppraisalTables(dir: string) {
  await mkdir(dir, { recursive: true });
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  const copy = (table: string, select: string) =>
    connection.run(`COPY (${select}) TO '${join(dir, `${table}.parquet`)}' (FORMAT parquet)`);

  await copy(
    "properties",
    `SELECT * FROM (VALUES
      (100008::BIGINT, 'R', '0100000001', 'DJB INVESTMENT PROPERTY LLC', '1 MARKET ST', NULL, NULL, 'SAN FRANCISCO', 'CA', '94105', NULL, '1201', NULL, 'LAMAR', 'BLVD', NULL, 'AUSTIN', '78704', DATE '2011-11-22', 4336640::BIGINT, 4336640::BIGINT, false, 0.5398, 1::BIGINT),
      (100008::BIGINT, 'R', '0100000001', 'SECOND PARTIAL OWNER', '12 OAK ST', NULL, NULL, 'AUSTIN', 'TX', '78704', NULL, '1201', NULL, 'LAMAR', 'BLVD', NULL, 'AUSTIN', '78704', DATE '2011-11-22', 4336640::BIGINT, 4336640::BIGINT, false, 0.5398, 2::BIGINT),
      (100012::BIGINT, 'R', '0100000002', 'JANE OWNER', '12 OAK ST', NULL, NULL, 'AUSTIN', 'TX', '78704', NULL, '12', NULL, 'OAK', 'ST', NULL, 'AUSTIN', '78704', DATE '0021-04-22', 500000::BIGINT, 450000::BIGINT, true, 0.2, 3::BIGINT),
      (100020::BIGINT, 'R', '0100000003', 'CONDO OWNER A', '5 ELM', NULL, NULL, 'AUSTIN', 'TX', '78701', NULL, '5', NULL, 'ELM', 'ST', '101', 'AUSTIN', '78701', NULL, 300000::BIGINT, 300000::BIGINT, true, NULL, 4::BIGINT),
      (100021::BIGINT, 'MH', '0100000003', 'CONDO OWNER B', '5 ELM', NULL, NULL, 'AUSTIN', 'TX', '78701', NULL, '5', NULL, 'ELM', 'ST', '102', 'AUSTIN', '78701', NULL, 300000::BIGINT, 300000::BIGINT, true, NULL, 5::BIGINT),
      (900001::BIGINT, 'P', '0100000009', 'SOME BUSINESS', '9 MAIN', NULL, NULL, 'AUSTIN', 'TX', '78701', NULL, '9', NULL, 'MAIN', 'ST', NULL, 'AUSTIN', '78701', NULL, 1000::BIGINT, 1000::BIGINT, false, NULL, 6::BIGINT)
    ) AS t(prop_id, prop_type_cd, geo_id, py_owner_name, py_addr_line1, py_addr_line2, py_addr_line3, py_addr_city, py_addr_state, py_addr_zip, py_addr_country, situs_num, situs_street_prefx, situs_street, situs_street_suffix, situs_unit, situs_city, situs_zip, deed_dt, market_value, appraised_val, hs_exempt, land_acres, py_owner_id)`,
  );
  await copy(
    "improvements",
    `SELECT * FROM (VALUES (100008::BIGINT, 1::BIGINT, 200000::BIGINT), (100008, 2, 5000), (100012, 3, 150000))
      AS t(prop_id, imprv_id, imprv_val)`,
  );
  await copy(
    "improvement_details",
    `SELECT * FROM (VALUES
      (100008::BIGINT, 1::BIGINT, '1st Floor', 1984::BIGINT),
      (100008, 2, '1st Floor', 2015),
      (100012, 3, '1st Floor', 2001)
    ) AS t(prop_id, imprv_id, imprv_det_type_desc, yr_built)`,
  );
  await copy(
    "improvement_attributes",
    `SELECT * FROM (VALUES
      (100008::BIGINT, 1::BIGINT, 'Roof Covering', 'COMPOSITIO'),
      (100008, 1, 'Roof Style', 'HIP'),
      (100008, 2, 'Roof Covering', 'METAL'),
      (100012, 3, 'Roof Covering', 'METAL'),
      (100012, 3, 'Roof Covering', 'COMPOSITIO')
    ) AS t(prop_id, imprv_id, imprv_attr_desc, imprv_attr_cd)`,
  );
}

let dataDir: string;
let inputs: BuildInputs;
let result: BuildResult;

async function readTable(buildId: string, table: string, orderBy: string): Promise<Row[]> {
  const connection = await (await DuckDBInstance.create(":memory:")).connect();
  const reader = await connection.runAndReadAll(
    `SELECT * FROM '${join(dataDir, "build", buildId, `${table}.parquet`)}' ORDER BY ${orderBy}`,
  );
  return reader.getRowObjectsJson() as Row[];
}

async function build(buildId: string, previousBuildId?: string) {
  const warehouse = await DuckDbLeadWarehouse.open();
  try {
    return await buildLeadTables(warehouse, {
      buildId,
      asOf: AS_OF,
      inputs,
      outputDir: join(dataDir, "build", buildId),
      previousDir: previousBuildId ? join(dataDir, "build", previousBuildId) : undefined,
    });
  } finally {
    warehouse.close();
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "travis-oracle-build-"));
  const permitsDir = join(dataDir, "raw", "austin-permits");
  await writeGzipJson(join(permitsDir, OLDER_RUN, "page-00001.json.gz"), OLDER_PERMITS);
  await writeGzipJson(join(permitsDir, LATEST_RUN, "page-00001.json.gz"), LATEST_PERMITS);
  await writeGzipJson(
    join(dataDir, "raw", "tcad-parcels", PARCEL_RUN, "page-00001.json.gz"),
    PARCELS,
  );
  const appraisalTablesDir = join(dataDir, "tables", "tcad-appraisal-export", APPRAISAL_RUN);
  await writeAppraisalTables(appraisalTablesDir);

  inputs = {
    permitPages: join(permitsDir, "*", "page-*.json.gz"),
    appraisalTablesDir,
    parcelPages: join(dataDir, "raw", "tcad-parcels", PARCEL_RUN, "page-*.json.gz"),
  };
  result = await build("build-1");
});

describe("DuckDbLeadWarehouse", () => {
  it("counts the latest permit versions, the county's real property and its parcels", () => {
    expect(result.sourceRows).toEqual({ permits: 6, properties: 4, parcels: 2 });
  });

  it("keeps the latest version of every permit with its source run", async () => {
    const permits = await readTable("build-1", "permits", "permit_number");

    expect(permits.map((row) => row.permit_number)).toEqual([
      "2001-000009 BP",
      "2010-000002 BP",
      "2016-023376 BP",
      "2020-000005 BP",
      "2021-000006 EP",
      "2022-000007 BP",
    ]);
    expect(permits.find((row) => row.permit_number === "2016-023376 BP")).toMatchObject({
      status: "Expired",
      source_run_id: LATEST_RUN,
      prop_id: "100008",
      link_status: "linked",
    });
  });

  it("publishes roofing permits with lifecycle, link, contractor and source", async () => {
    const roofing = await readTable("build-1", "roofing_permits", "permit_number");

    expect(roofing.map((row) => row.permit_number)).toEqual([
      "2010-000002 BP",
      "2016-023376 BP",
      "2020-000005 BP",
    ]);
    expect(roofing[1]).toMatchObject({
      roof_work: "replacement",
      permit_state: "expired",
      unfinished: true,
      open_since: "2016-03-03",
      years_open: 10,
      past_expiry: true,
      prop_id: "100008",
      latitude: 30.26,
      longitude: -97.75,
      coordinate_source: "parcel_centroid",
      contractor_name: "Reliable Roofing, Inc.",
      contractor_key: "reliable roofing",
      source: "austin-permits",
      source_url: "https://abc.austintexas.gov/permit/2016-023376 BP",
    });
    expect(roofing[2]).toMatchObject({
      prop_id: null,
      link_status: "ambiguous_parcel",
      latitude: 30.3001,
      coordinate_source: "permit",
    });
  });

  it("builds one lead row per property, keeping every partial owner, with roof, owner and location evidence", async () => {
    const properties = await readTable("build-1", "properties", "prop_id");

    expect(properties.map((row) => row.prop_id)).toEqual(["100008", "100012", "100020", "100021"]);
    expect(properties[0]).toMatchObject({
      situs_address: "1201 LAMAR BLVD",
      owner_name: "DJB INVESTMENT PROPERTY LLC",
      owner_names: ["DJB INVESTMENT PROPERTY LLC", "SECOND PARTIAL OWNER"],
      owner_count: "2",
      mailing_state: "CA",
      owner_locality: "out_of_state",
      ownership_years: 14,
      year_built: "1984",
      roof_covering: "COMPOSITIO",
      roof_style: "HIP",
      roof_age_years: 15,
      roof_age_anchor: "completed_replacement",
      roof_age_anchor_date: "2010-10-28",
      roof_age_anchor_permit: "2010-000002 BP",
      roof_age_confidence: "high",
      roofing_permits: "2",
      unfinished_roofing_permits: "1",
      max_years_open: 10,
      latitude: 30.26,
      longitude: -97.75,
      coordinate_source: "parcel_centroid",
      source: "tcad-appraisal-export",
      source_run_id: APPRAISAL_RUN,
    });
    expect(properties[1]).toMatchObject({
      roof_covering: "COMPOSITIO",
      owner_locality: "local",
      ownership_years: null,
      roof_age_anchor: "new_construction",
      roof_age_years: 25,
      roof_age_confidence: "medium",
    });
  });

  it("groups contractor name variants under one key", async () => {
    const contractors = await readTable("build-1", "contractors", "contractor_key");

    expect(contractors).toHaveLength(1);
    expect(contractors[0]).toMatchObject({
      contractor_key: "reliable roofing",
      roofing_permits: "2",
      unfinished_roofing_permits: "1",
      properties: "1",
    });
    expect(contractors[0]?.names).toEqual(
      expect.arrayContaining(["RELIABLE ROOFING OF TEXAS INC", "Reliable Roofing, Inc."]),
    );
  });

  it("writes a coverage report with fill rates for the fields leads depend on", async () => {
    const coverage = JSON.parse(
      await readFile(join(dataDir, "build", "build-1", "coverage.json"), "utf8"),
    );

    expect(coverage.properties).toMatchObject({
      rows: 4,
      with_coordinates: 2,
      with_year_built: 2,
      with_roof_age: 2,
      roof_age_confidence: { high: 1, medium: 1 },
      owner_locality: { out_of_state: 1, local: 3 },
    });
    expect(coverage.roofing_permits).toMatchObject({
      rows: 3,
      unfinished: 2,
      with_contractor: 2,
      link_status: { linked: 2, ambiguous_parcel: 1 },
    });
  });

  it("writes small CSV extracts of the strongest leads", async () => {
    const extract = (name: string) =>
      readFile(join(dataDir, "build", "build-1", "samples", name), "utf8");

    const longOpen = (await extract("long-open-roofing-permits.csv")).trim().split("\n");
    expect(longOpen[0]).toContain("permit_number");
    expect(longOpen[1]).toContain("2016-023376 BP");
    const agedRoofs = (await extract("aged-roofs.csv")).trim().split("\n");
    expect(agedRoofs).toHaveLength(2);
    expect(agedRoofs[1]).toContain("100012");
  });

  it("reports every row as added on the first build", () => {
    expect(result.tables).toEqual(
      expect.arrayContaining([
        { table: "properties", rows: 4, added: 4, changed: 0, removed: 0 },
        { table: "roofing_permits", rows: 3, added: 3, changed: 0, removed: 0 },
      ]),
    );
  });

  it("reports no changes when rebuilt from the same inputs", async () => {
    const rebuilt = await build("build-2", "build-1");

    for (const table of rebuilt.tables) {
      expect(table).toMatchObject({ added: 0, changed: 0, removed: 0 });
    }
  });

  it("writes byte-identical tables from the same inputs, so unchanged tables keep their CIDs", async () => {
    await build("build-3", "build-1");

    for (const table of ["permits", "roofing_permits", "properties", "contractors"]) {
      const digest = async (buildId: string) =>
        createHash("sha256")
          .update(await readFile(join(dataDir, "build", buildId, `${table}.parquet`)))
          .digest("hex");
      expect(await digest("build-3")).toBe(await digest("build-1"));
    }
  });
});
