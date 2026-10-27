import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { type DuckDBAppender, type DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type {
  BuildInputs,
  ClassifiedPermit,
  ContractorKey,
  ContractorName,
  LeadWarehouse,
  OwnerFacts,
  OwnerSignals,
  PermitCandidate,
  PropertyRoofAge,
  PropertyRoofEvidence,
  TableSummary,
} from "../application/lead-build-ports.js";
import {
  AGED_ROOF_YEARS,
  LONG_OPEN_PERMIT_YEARS,
  LONG_OWNERSHIP_YEARS,
} from "../domain/lead-thresholds.js";
import { PermitLinkStatus } from "../domain/permit-link.js";
import type { PermitState } from "../domain/permit-state.js";
import { Confidence } from "../domain/roof-age.js";
import { ROOF_AGE_EVIDENCE, ROOFING_WORK, type RoofWork } from "../domain/roof-work.js";
import { SourceId } from "../domain/source-id.js";
import {
  TCAD_MAIN_FLOOR_DETAIL,
  TCAD_REAL_PROPERTY_TYPES,
  TCAD_ROOF_COVERING_ATTRIBUTE,
  TCAD_ROOF_STYLE_ATTRIBUTE,
  TcadTable,
} from "../domain/tcad-export-layout.js";

type Row = Record<string, unknown>;

const BUILDING_PERMIT = "BP";
const CANDIDATE_WORK_CLASSES = ["new", "roof"];
const RAW_RUN_ID = String.raw`/(\d{8}T\d{6}Z)/page-`;
const ISO_DATE = "%Y-%m-%d";
const COVERAGE_FILE = "coverage.json";
const SAMPLES_DIR = "samples";
const LONG_OPEN_SAMPLE_FILE = "long-open-roofing-permits.csv";
const AGED_ROOFS_SAMPLE_FILE = "aged-roofs.csv";
const SAMPLE_ROWS = 100;
const PROVENANCE_COLUMNS = ["source_run_id"];
const CONFIDENCE_ORDER = [Confidence.High, Confidence.Medium, Confidence.Low]
  .map((confidence, rank) => `WHEN '${confidence}' THEN ${rank}`)
  .join(" ");
const WHOLE_RAW_PAGE_JSON_BUFFER_BYTES = 134_217_728;
const WAREHOUSE_CONFIG = { memory_limit: "8GB", preserve_insertion_order: "false" };

enum CoordinateSource {
  Permit = "permit",
  ParcelCentroid = "parcel_centroid",
}

enum ExportTable {
  Permits = "permits",
  RoofingPermits = "roofing_permits",
  Properties = "properties",
  Contractors = "contractors",
}

const EXPORT_KEYS: Record<ExportTable, string> = {
  [ExportTable.Permits]: "permit_number",
  [ExportTable.RoofingPermits]: "permit_number",
  [ExportTable.Properties]: "prop_id",
  [ExportTable.Contractors]: "contractor_key",
};

const PERMIT_COLUMNS = {
  permit_number: "VARCHAR",
  permittype: "VARCHAR",
  permit_class_mapped: "VARCHAR",
  permit_class: "VARCHAR",
  work_class: "VARCHAR",
  description: "VARCHAR",
  status_current: "VARCHAR",
  applieddate: "VARCHAR",
  issue_date: "VARCHAR",
  statusdate: "VARCHAR",
  completed_date: "VARCHAR",
  expiresdate: "VARCHAR",
  original_address1: "VARCHAR",
  original_city: "VARCHAR",
  original_zip: "VARCHAR",
  tcad_id: "VARCHAR",
  latitude: "VARCHAR",
  longitude: "VARCHAR",
  contractor_trade: "VARCHAR",
  contractor_company_name: "VARCHAR",
  contractor_full_name: "VARCHAR",
  contractor_phone: "VARCHAR",
  contractor_address1: "VARCHAR",
  contractor_city: "VARCHAR",
  contractor_zip: "VARCHAR",
  project_id: "VARCHAR",
  masterpermitnum: "VARCHAR",
  jurisdiction: "VARCHAR",
  total_job_valuation: "VARCHAR",
  link: "STRUCT(url VARCHAR)",
};

const PARCEL_FEATURES =
  "STRUCT(attributes STRUCT(PROP_ID BIGINT, PID_10 VARCHAR, Shape__Area DOUBLE), centroid STRUCT(x DOUBLE, y DOUBLE))[]";

export class DuckDbLeadWarehouse implements LeadWarehouse {
  private appraisalRunId = "";

  private constructor(private readonly connection: DuckDBConnection) {}

  static async open(): Promise<DuckDbLeadWarehouse> {
    const instance = await DuckDBInstance.create(":memory:", WAREHOUSE_CONFIG);
    return new DuckDbLeadWarehouse(await instance.connect());
  }

  close(): void {
    this.connection.closeSync();
  }

  async load({ permitPages, appraisalTablesDir, parcelPages }: BuildInputs) {
    this.appraisalRunId = basename(appraisalTablesDir);
    const tcad = (table: TcadTable) => literal(join(appraisalTablesDir, `${table}.parquet`));

    await this.connection.run(`
      CREATE TABLE permits AS
      WITH raw AS (
        SELECT *, regexp_extract(filename, ${literal(RAW_RUN_ID)}, 1) AS source_run_id
        FROM read_json(${literal(permitPages)}, format = 'array', filename = true, maximum_object_size = ${WHOLE_RAW_PAGE_JSON_BUFFER_BYTES}, columns = ${structLiteral(PERMIT_COLUMNS)})
      )
      SELECT
        permit_number, permittype AS permit_type, permit_class_mapped AS permit_class_group, permit_class,
        work_class, description, status_current AS status,
        ${date("applieddate")} AS applied_date, ${date("issue_date")} AS issue_date,
        ${date("statusdate")} AS status_date, ${date("completed_date")} AS completed_date,
        ${date("expiresdate")} AS expires_date,
        original_address1 AS address, original_city AS city, original_zip AS zip, tcad_id AS geo_id,
        TRY_CAST(latitude AS DOUBLE) AS latitude, TRY_CAST(longitude AS DOUBLE) AS longitude,
        contractor_trade, contractor_company_name, contractor_full_name, contractor_phone,
        contractor_address1, contractor_city, contractor_zip,
        project_id, masterpermitnum AS master_permit_number, jurisdiction,
        TRY_CAST(total_job_valuation AS DOUBLE) AS job_valuation,
        link.url AS source_url, source_run_id
      FROM raw
      WHERE permit_number IS NOT NULL
      QUALIFY row_number() OVER (PARTITION BY permit_number ORDER BY source_run_id DESC) = 1;

      CREATE TABLE tcad_property_rows AS
        SELECT * FROM read_parquet(${tcad(TcadTable.Properties)})
        WHERE prop_type_cd IN (${list(TCAD_REAL_PROPERTY_TYPES)});
      CREATE TABLE tcad_owners AS
        SELECT prop_id, list(py_owner_name ORDER BY py_owner_id, py_owner_name) AS owner_names, count(*) AS owner_count
        FROM tcad_property_rows GROUP BY prop_id;
      CREATE TABLE tcad_properties AS
        SELECT * FROM tcad_property_rows
        QUALIFY row_number() OVER (PARTITION BY prop_id ORDER BY py_owner_id, py_owner_name) = 1;
      CREATE TABLE tcad_improvements AS SELECT * FROM read_parquet(${tcad(TcadTable.Improvements)});
      CREATE TABLE tcad_improvement_details AS
        SELECT * FROM read_parquet(${tcad(TcadTable.ImprovementDetails)})
        WHERE imprv_det_type_desc = ${literal(TCAD_MAIN_FLOOR_DETAIL)} AND yr_built > 0;
      CREATE TABLE tcad_roof_attributes AS
        SELECT * FROM read_parquet(${tcad(TcadTable.ImprovementAttributes)})
        WHERE imprv_attr_desc IN (${list([TCAD_ROOF_COVERING_ATTRIBUTE, TCAD_ROOF_STYLE_ATTRIBUTE])});

      CREATE TABLE parcels AS
      WITH features AS (
        SELECT unnest(features) AS feature
        FROM read_json(${literal(parcelPages)}, columns = {'features': '${PARCEL_FEATURES}'})
      )
      SELECT feature.attributes.PROP_ID AS prop_id,
        feature.centroid.y AS latitude,
        feature.centroid.x AS longitude
      FROM features
      WHERE feature.attributes.PROP_ID IS NOT NULL AND feature.centroid IS NOT NULL
      QUALIFY row_number() OVER (
        PARTITION BY feature.attributes.PROP_ID
        ORDER BY feature.attributes.Shape__Area DESC NULLS LAST, feature.centroid.y, feature.centroid.x
      ) = 1;

      CREATE TABLE main_improvement AS
        SELECT prop_id, imprv_id FROM tcad_improvements
        QUALIFY row_number() OVER (PARTITION BY prop_id ORDER BY imprv_val DESC NULLS LAST, imprv_id) = 1;

      CREATE TABLE property_year_built AS
      WITH main_floor AS (
        SELECT d.prop_id, min(d.yr_built) AS year_built
        FROM tcad_improvement_details d JOIN main_improvement m USING (prop_id, imprv_id)
        GROUP BY 1
      ), any_floor AS (
        SELECT prop_id, min(yr_built) AS year_built FROM tcad_improvement_details GROUP BY 1
      )
      SELECT p.prop_id, coalesce(main_floor.year_built, any_floor.year_built) AS year_built
      FROM tcad_properties p
      LEFT JOIN main_floor USING (prop_id)
      LEFT JOIN any_floor USING (prop_id);

      CREATE TABLE permit_links AS
      WITH geo_properties AS (
        SELECT geo_id, list(prop_id) AS prop_ids FROM tcad_properties WHERE geo_id IS NOT NULL GROUP BY 1
      )
      SELECT p.permit_number,
        CASE WHEN len(g.prop_ids) = 1 THEN g.prop_ids[1] END AS prop_id,
        CASE
          WHEN p.geo_id IS NULL THEN ${literal(PermitLinkStatus.MissingParcelId)}
          WHEN g.geo_id IS NULL THEN ${literal(PermitLinkStatus.ParcelNotInRoll)}
          WHEN len(g.prop_ids) > 1 THEN ${literal(PermitLinkStatus.AmbiguousParcel)}
          ELSE ${literal(PermitLinkStatus.Linked)}
        END AS link_status
      FROM permits p LEFT JOIN geo_properties g USING (geo_id);
    `);

    return {
      permits: await this.count("permits"),
      properties: await this.count("tcad_properties"),
      parcels: await this.count("parcels"),
    };
  }

  async permitCandidates(): Promise<PermitCandidate[]> {
    const rows = await this.rows(`
      SELECT permit_number, permit_type, work_class, permit_class, description, status,
        ${isoDate("applied_date")} AS applied_date, ${isoDate("issue_date")} AS issue_date,
        ${isoDate("completed_date")} AS completed_date, ${isoDate("expires_date")} AS expires_date
      FROM permits
      WHERE upper(permit_type) = ${literal(BUILDING_PERMIT)}
        AND (description ILIKE '%roof%' OR lower(work_class) IN (${list(CANDIDATE_WORK_CLASSES)}))
    `);
    return rows.map((row) => ({
      permitNumber: String(row.permit_number),
      permitType: text(row.permit_type),
      workClass: text(row.work_class),
      permitClass: text(row.permit_class),
      description: text(row.description),
      status: text(row.status),
      appliedDate: text(row.applied_date),
      issueDate: text(row.issue_date),
      completedDate: text(row.completed_date),
      expiresDate: text(row.expires_date),
    }));
  }

  async saveClassifiedPermits(rows: readonly ClassifiedPermit[]): Promise<void> {
    await this.connection.run(`
      CREATE OR REPLACE TABLE permit_roof_work (
        permit_number VARCHAR, roof_work VARCHAR, roof_work_basis VARCHAR, permit_state VARCHAR,
        unfinished BOOLEAN, open_since VARCHAR, years_open INTEGER, past_expiry BOOLEAN
      )`);
    await this.append("permit_roof_work", rows, (appender, row) => {
      appender.appendVarchar(row.permitNumber);
      appender.appendVarchar(row.roofWork);
      appender.appendVarchar(row.roofWorkBasis);
      appender.appendVarchar(row.state);
      appender.appendBoolean(row.unfinished);
      appendOptionalVarchar(appender, row.openSince);
      appendOptionalInteger(appender, row.yearsOpen);
      appender.appendBoolean(row.pastExpiry);
    });
  }

  async roofEvidence(): Promise<PropertyRoofEvidence[]> {
    const rows = await this.rows(`
      WITH evidence AS (
        SELECT l.prop_id, list({
          'permitNumber': w.permit_number,
          'work': w.roof_work,
          'state': w.permit_state,
          'completedDate': ${isoDate("p.completed_date")}
        } ORDER BY w.permit_number) AS permits
        FROM permit_roof_work w
        JOIN permit_links l USING (permit_number)
        JOIN permits p USING (permit_number)
        WHERE l.prop_id IS NOT NULL AND w.roof_work IN (${list(ROOF_AGE_EVIDENCE)})
        GROUP BY 1
      )
      SELECT y.prop_id, y.year_built, coalesce(e.permits, []) AS permits
      FROM property_year_built y LEFT JOIN evidence e USING (prop_id)
    `);
    return rows.map((row) => ({
      propId: Number(row.prop_id),
      yearBuilt: row.year_built === null ? undefined : Number(row.year_built),
      permits: (row.permits as Row[]).map((permit) => ({
        permitNumber: String(permit.permitNumber),
        work: permit.work as RoofWork,
        state: permit.state as PermitState,
        completedDate: text(permit.completedDate),
      })),
    }));
  }

  async saveRoofAges(rows: readonly PropertyRoofAge[]): Promise<void> {
    await this.connection.run(`
      CREATE OR REPLACE TABLE property_roof_age (
        prop_id BIGINT, roof_age_anchor VARCHAR, roof_age_anchor_date VARCHAR,
        roof_age_anchor_permit VARCHAR, roof_age_years INTEGER, roof_age_confidence VARCHAR
      )`);
    await this.append("property_roof_age", rows, (appender, row) => {
      appender.appendBigInt(BigInt(row.propId));
      appender.appendVarchar(row.anchor);
      appender.appendVarchar(row.anchorDate);
      appendOptionalVarchar(appender, row.anchorPermitNumber);
      appender.appendInteger(row.estimatedAgeYears);
      appender.appendVarchar(row.confidence);
    });
  }

  async ownerFacts(): Promise<OwnerFacts[]> {
    const rows = await this.rows(`
      SELECT prop_id, py_addr_state, py_addr_zip, py_addr_country, ${isoDate("deed_dt")} AS deed_date
      FROM tcad_properties
    `);
    return rows.map((row) => ({
      propId: Number(row.prop_id),
      mailing: {
        state: text(row.py_addr_state),
        zip: text(row.py_addr_zip),
        country: text(row.py_addr_country),
      },
      deedDate: text(row.deed_date),
    }));
  }

  async saveOwnerSignals(rows: readonly OwnerSignals[]): Promise<void> {
    await this.connection.run(
      "CREATE OR REPLACE TABLE owner_signals (prop_id BIGINT, owner_locality VARCHAR, ownership_years INTEGER)",
    );
    await this.append("owner_signals", rows, (appender, row) => {
      appender.appendBigInt(BigInt(row.propId));
      appender.appendVarchar(row.locality);
      appendOptionalInteger(appender, row.ownershipYears);
    });
  }

  async contractorNames(): Promise<ContractorName[]> {
    const rows = await this.rows(`
      SELECT DISTINCT coalesce(p.contractor_company_name, p.contractor_full_name) AS name, p.contractor_phone AS phone
      FROM permits p JOIN permit_roof_work w USING (permit_number)
      WHERE w.roof_work IN (${list(ROOFING_WORK)})
    `);
    return rows.map((row) => ({ name: text(row.name), phone: text(row.phone) }));
  }

  async saveContractorKeys(rows: readonly ContractorKey[]): Promise<void> {
    await this.connection.run(
      "CREATE OR REPLACE TABLE contractor_keys (name VARCHAR, phone VARCHAR, contractor_key VARCHAR, phone_key VARCHAR)",
    );
    await this.append("contractor_keys", rows, (appender, row) => {
      appendOptionalVarchar(appender, row.name);
      appendOptionalVarchar(appender, row.phone);
      appender.appendVarchar(row.contractorKey);
      appendOptionalVarchar(appender, row.phoneKey);
    });
  }

  async exportTables(outputDir: string, previousDir: string | undefined): Promise<TableSummary[]> {
    await this.connection.run(`
      CREATE OR REPLACE VIEW export_permits AS
        SELECT p.*, l.prop_id, l.link_status FROM permits p JOIN permit_links l USING (permit_number);

      CREATE OR REPLACE VIEW export_roofing_permits AS
      SELECT
        p.permit_number, p.permit_type, p.work_class, p.permit_class, p.description, p.status,
        w.permit_state, w.roof_work, w.roof_work_basis, w.unfinished, CAST(w.open_since AS DATE) AS open_since,
        w.years_open, w.past_expiry,
        p.applied_date, p.issue_date, p.status_date, p.completed_date, p.expires_date,
        p.address, p.city, p.zip, p.geo_id, l.prop_id, l.link_status,
        coalesce(p.latitude, parcel.latitude) AS latitude,
        coalesce(p.longitude, parcel.longitude) AS longitude,
        CASE
          WHEN p.latitude IS NOT NULL THEN ${literal(CoordinateSource.Permit)}
          WHEN parcel.latitude IS NOT NULL THEN ${literal(CoordinateSource.ParcelCentroid)}
        END AS coordinate_source,
        coalesce(p.contractor_company_name, p.contractor_full_name) AS contractor_name,
        p.contractor_phone, k.contractor_key, p.contractor_trade,
        p.project_id, p.master_permit_number, p.job_valuation, p.source_url,
        ${literal(SourceId.AustinPermits)} AS source, p.source_run_id
      FROM permits p
      JOIN permit_roof_work w USING (permit_number)
      JOIN permit_links l USING (permit_number)
      LEFT JOIN parcels parcel ON parcel.prop_id = l.prop_id
      LEFT JOIN contractor_keys k
        ON k.name IS NOT DISTINCT FROM coalesce(p.contractor_company_name, p.contractor_full_name)
        AND k.phone IS NOT DISTINCT FROM p.contractor_phone
      WHERE w.roof_work IN (${list(ROOFING_WORK)});

      CREATE OR REPLACE VIEW export_properties AS
      WITH attribute_counts AS (
        SELECT a.prop_id, a.imprv_attr_desc, a.imprv_attr_cd, count(*) AS occurrences
        FROM tcad_roof_attributes a JOIN main_improvement m USING (prop_id, imprv_id)
        WHERE a.imprv_attr_cd IS NOT NULL
        GROUP BY 1, 2, 3
      ), roof_attributes AS (
        SELECT prop_id,
          first(imprv_attr_cd ORDER BY occurrences DESC, imprv_attr_cd)
            FILTER (WHERE imprv_attr_desc = ${literal(TCAD_ROOF_COVERING_ATTRIBUTE)}) AS roof_covering,
          first(imprv_attr_cd ORDER BY occurrences DESC, imprv_attr_cd)
            FILTER (WHERE imprv_attr_desc = ${literal(TCAD_ROOF_STYLE_ATTRIBUTE)}) AS roof_style
        FROM attribute_counts
        GROUP BY 1
      ), roofing AS (
        SELECT prop_id, count(*) AS roofing_permits,
          count(*) FILTER (WHERE unfinished) AS unfinished_roofing_permits,
          max(years_open) AS max_years_open, max(issue_date) AS last_roofing_permit_issued
        FROM export_roofing_permits WHERE prop_id IS NOT NULL GROUP BY 1
      )
      SELECT
        p.prop_id, p.geo_id, p.prop_type_cd AS property_type,
        concat_ws(' ', p.situs_num, p.situs_street_prefx, p.situs_street, p.situs_street_suffix, p.situs_unit) AS situs_address,
        p.situs_city, p.situs_zip,
        p.py_owner_name AS owner_name, owners.owner_names, owners.owner_count,
        p.py_addr_line1 AS mailing_line1, p.py_addr_line2 AS mailing_line2,
        p.py_addr_line3 AS mailing_line3, p.py_addr_city AS mailing_city, p.py_addr_state AS mailing_state,
        p.py_addr_zip AS mailing_zip, p.py_addr_country AS mailing_country,
        o.owner_locality, p.deed_dt AS deed_date, o.ownership_years,
        p.market_value, p.appraised_val AS appraised_value, p.hs_exempt AS homestead, p.land_acres,
        y.year_built, ra.roof_covering, ra.roof_style,
        a.roof_age_years, a.roof_age_anchor, a.roof_age_anchor_date, a.roof_age_anchor_permit, a.roof_age_confidence,
        coalesce(r.roofing_permits, 0) AS roofing_permits,
        coalesce(r.unfinished_roofing_permits, 0) AS unfinished_roofing_permits,
        r.max_years_open, r.last_roofing_permit_issued,
        parcel.latitude, parcel.longitude,
        CASE WHEN parcel.latitude IS NOT NULL THEN ${literal(CoordinateSource.ParcelCentroid)} END AS coordinate_source,
        ${literal(SourceId.TcadAppraisalExport)} AS source, ${literal(this.appraisalRunId)} AS source_run_id
      FROM tcad_properties p
      JOIN tcad_owners owners USING (prop_id)
      LEFT JOIN owner_signals o USING (prop_id)
      LEFT JOIN property_year_built y USING (prop_id)
      LEFT JOIN roof_attributes ra USING (prop_id)
      LEFT JOIN property_roof_age a USING (prop_id)
      LEFT JOIN roofing r USING (prop_id)
      LEFT JOIN parcels parcel USING (prop_id);

      CREATE OR REPLACE VIEW export_contractors AS
      SELECT contractor_key,
        list(DISTINCT contractor_name ORDER BY contractor_name) AS names,
        list(DISTINCT contractor_phone ORDER BY contractor_phone) FILTER (WHERE contractor_phone IS NOT NULL) AS phones,
        count(*) AS roofing_permits,
        count(*) FILTER (WHERE unfinished) AS unfinished_roofing_permits,
        count(DISTINCT prop_id) AS properties,
        min(issue_date) AS first_issue_date, max(issue_date) AS last_issue_date,
        CAST(NULL AS VARCHAR) AS bbb_rating, CAST(NULL AS VARCHAR) AS bbb_profile_url,
        CAST(NULL AS DATE) AS bbb_snapshot_date
      FROM export_roofing_permits
      WHERE contractor_key IS NOT NULL
      GROUP BY 1;
    `);

    await mkdir(outputDir, { recursive: true });
    const summaries: TableSummary[] = [];
    for (const table of Object.values(ExportTable)) {
      summaries.push(await this.exportTable(table, outputDir, previousDir));
    }
    await this.exportCoverage(outputDir);
    await this.exportSamples(outputDir);
    return summaries;
  }

  private async exportCoverage(outputDir: string): Promise<void> {
    const [properties] = await this.rows(`
      SELECT count(*) AS rows, count(latitude) AS with_coordinates, count(year_built) AS with_year_built,
        count(roof_age_years) AS with_roof_age, count(roof_covering) AS with_roof_covering,
        count(*) FILTER (WHERE roof_age_years > ${AGED_ROOF_YEARS}) AS roof_older_than_${AGED_ROOF_YEARS}_years,
        count(*) FILTER (WHERE ownership_years > ${LONG_OWNERSHIP_YEARS}) AS owned_longer_than_${LONG_OWNERSHIP_YEARS}_years
      FROM export_properties`);
    const [roofing] = await this.rows(`
      SELECT count(*) AS rows, count(*) FILTER (WHERE unfinished) AS unfinished,
        count(*) FILTER (WHERE unfinished AND years_open >= ${LONG_OPEN_PERMIT_YEARS}) AS open_${LONG_OPEN_PERMIT_YEARS}_years_or_more,
        count(contractor_name) AS with_contractor, count(latitude) AS with_coordinates
      FROM export_roofing_permits`);
    const [permits] = await this.rows(
      "SELECT count(*) AS rows, count(geo_id) AS with_parcel_id FROM export_permits",
    );
    const coverage = {
      properties: {
        ...numbers(properties),
        roof_age_confidence: await this.histogram("export_properties", "roof_age_confidence"),
        owner_locality: await this.histogram("export_properties", "owner_locality"),
      },
      roofing_permits: {
        ...numbers(roofing),
        roof_work: await this.histogram("export_roofing_permits", "roof_work"),
        permit_state: await this.histogram("export_roofing_permits", "permit_state"),
        link_status: await this.histogram("export_roofing_permits", "link_status"),
      },
      permits: {
        ...numbers(permits),
        link_status: await this.histogram("export_permits", "link_status"),
      },
      contractors: { rows: await this.count("export_contractors") },
    };
    await writeFile(join(outputDir, COVERAGE_FILE), `${JSON.stringify(coverage, null, 2)}\n`);
  }

  private async exportSamples(outputDir: string): Promise<void> {
    const samplesDir = join(outputDir, SAMPLES_DIR);
    await mkdir(samplesDir, { recursive: true });
    await this.connection.run(`
      COPY (
        SELECT permit_number, address, permit_state, roof_work, open_since, years_open, past_expiry,
          contractor_name, contractor_phone, latitude, longitude, source_url
        FROM export_roofing_permits
        WHERE unfinished
        ORDER BY years_open DESC NULLS LAST, permit_number
        LIMIT ${SAMPLE_ROWS}
      ) TO ${literal(join(samplesDir, LONG_OPEN_SAMPLE_FILE))} (HEADER, DELIMITER ',');
      COPY (
        SELECT prop_id, situs_address, situs_zip, year_built, roof_covering, roof_style, roof_age_years,
          roof_age_anchor, roof_age_anchor_date, roof_age_confidence, latitude, longitude
        FROM export_properties
        WHERE roof_age_years > ${AGED_ROOF_YEARS}
        ORDER BY CASE roof_age_confidence ${CONFIDENCE_ORDER} END, roof_age_years DESC, prop_id
        LIMIT ${SAMPLE_ROWS}
      ) TO ${literal(join(samplesDir, AGED_ROOFS_SAMPLE_FILE))} (HEADER, DELIMITER ',');
    `);
  }

  private async histogram(relation: string, column: string): Promise<Record<string, number>> {
    const rows = await this.rows(
      `SELECT ${column} AS key, count(*) AS n FROM ${relation} WHERE ${column} IS NOT NULL GROUP BY 1 ORDER BY 1`,
    );
    return Object.fromEntries(rows.map((row) => [String(row.key), Number(row.n)]));
  }

  private async exportTable(
    table: ExportTable,
    outputDir: string,
    previousDir: string | undefined,
  ): Promise<TableSummary> {
    const key = EXPORT_KEYS[table];
    const output = join(outputDir, `${table}.parquet`);
    await this.connection.run(
      `COPY (SELECT * FROM export_${table} ORDER BY ${key}) TO ${literal(output)} (FORMAT parquet, COMPRESSION zstd)`,
    );
    const rows = await this.count(`read_parquet(${literal(output)})`);

    const previous = previousDir ? join(previousDir, `${table}.parquet`) : undefined;
    if (previous === undefined || !(await exists(previous))) {
      return { table, rows, added: rows, changed: 0, removed: 0 };
    }

    const content = await this.contentFingerprint(output);
    const [delta] = await this.rows(`
      WITH current AS (SELECT ${key} AS k, ${content} AS h FROM read_parquet(${literal(output)}) t),
      previous AS (SELECT ${key} AS k, ${content} AS h FROM read_parquet(${literal(previous)}) t)
      SELECT
        count(*) FILTER (WHERE previous.k IS NULL) AS added,
        count(*) FILTER (WHERE current.k IS NOT NULL AND previous.k IS NOT NULL AND current.h <> previous.h) AS changed,
        count(*) FILTER (WHERE current.k IS NULL) AS removed
      FROM current FULL OUTER JOIN previous ON current.k = previous.k
    `);
    return {
      table,
      rows,
      added: Number(delta?.added ?? 0),
      changed: Number(delta?.changed ?? 0),
      removed: Number(delta?.removed ?? 0),
    };
  }

  private async contentFingerprint(parquet: string): Promise<string> {
    const columns = (await this.rows(`DESCRIBE SELECT * FROM read_parquet(${literal(parquet)})`))
      .map((row) => String(row.column_name))
      .filter((column) => !PROVENANCE_COLUMNS.includes(column));
    return `md5(CAST(struct_pack(${columns.map((column) => `"${column}" := t."${column}"`).join(", ")}) AS VARCHAR))`;
  }

  private async rows(sql: string): Promise<Row[]> {
    return (await this.connection.runAndReadAll(sql)).getRowObjectsJson() as Row[];
  }

  private async count(relation: string): Promise<number> {
    const [row] = await this.rows(`SELECT count(*) AS n FROM ${relation}`);
    return Number(row?.n ?? 0);
  }

  private async append<T>(
    table: string,
    rows: readonly T[],
    write: (appender: DuckDBAppender, row: T) => void,
  ): Promise<void> {
    const appender = await this.connection.createAppender(table);
    for (const row of rows) {
      write(appender, row);
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();
  }
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function list(values: readonly string[]): string {
  return values.map(literal).join(", ");
}

function structLiteral(columns: Record<string, string>): string {
  return `{${Object.entries(columns)
    .map(([name, type]) => `${literal(name)}: ${literal(type)}`)
    .join(", ")}}`;
}

function date(column: string): string {
  return `CAST(TRY_CAST(${column} AS TIMESTAMP) AS DATE)`;
}

function isoDate(column: string): string {
  return `strftime(${column}, ${literal(ISO_DATE)})`;
}

function text(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function appendOptionalVarchar(appender: DuckDBAppender, value: string | undefined): void {
  if (value === undefined) appender.appendNull();
  else appender.appendVarchar(value);
}

function appendOptionalInteger(appender: DuckDBAppender, value: number | undefined): void {
  if (value === undefined) appender.appendNull();
  else appender.appendInteger(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function numbers(row: Row | undefined): Record<string, number> {
  return Object.fromEntries(Object.entries(row ?? {}).map(([key, value]) => [key, Number(value)]));
}
