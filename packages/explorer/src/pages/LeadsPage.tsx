import { PLACES, type Row, runTool, type ToolResult } from "@travis-oracle/query-core";
import { useEffect, useMemo, useState } from "react";
import { Badge, Card, Cid, DataTable, Disclosure, ErrorNote, Spinner } from "../components/ui.js";
import type { Dataset } from "../data/dataset.js";
import type { Database } from "../data/duckdb.js";
import { formatCount, formatValue } from "../format.js";
import { LeadsMap, type MapCenter, type MapPoint } from "../map/LeadsMap.js";
import { datasetInfo } from "./dataset-info.js";

enum LeadKind {
  AgedRoofs = "aged_roofs",
  OpenPermits = "open_permits",
  LongHeld = "long_held",
  OutOfArea = "out_of_area",
}

const LEAD_KINDS: { kind: LeadKind; label: string; tool: string }[] = [
  { kind: LeadKind.AgedRoofs, label: "Aged roofs", tool: "find_aged_roofs" },
  { kind: LeadKind.OpenPermits, label: "Open roofing permits", tool: "find_open_roofing_permits" },
  { kind: LeadKind.LongHeld, label: "Long-held properties", tool: "find_long_held_properties" },
  { kind: LeadKind.OutOfArea, label: "Out-of-area owners", tool: "find_out_of_area_owners" },
];

const COLUMNS: Record<LeadKind, string[]> = {
  [LeadKind.AgedRoofs]: [
    "situs_address",
    "roof_age_years",
    "roof_age_anchor",
    "roof_age_anchor_date",
    "roof_age_confidence",
    "roof_covering",
    "distance_miles",
    "coordinate_source",
    "source",
    "prop_id",
  ],
  [LeadKind.OpenPermits]: [
    "permit_number",
    "address",
    "permit_state",
    "years_open",
    "open_since",
    "roof_work",
    "contractor_name",
    "bbb_rating",
    "bbb_snapshot_date",
    "distance_miles",
    "source_url",
  ],
  [LeadKind.LongHeld]: [
    "situs_address",
    "ownership_years",
    "owner_name",
    "owner_locality",
    "mailing_state",
    "distance_miles",
    "source",
    "prop_id",
  ],
  [LeadKind.OutOfArea]: [
    "situs_address",
    "owner_name",
    "owner_locality",
    "mailing_state",
    "ownership_years",
    "distance_miles",
    "source",
    "prop_id",
  ],
};

const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const DEFAULT_PLACE = "Austin";
const DEFAULT_RADIUS_MILES = 5;
const MAX_RADIUS_MILES = 30;
const MAP_ROWS = 200;
const DEFAULT_ROOF_AGE = 15;
const DEFAULT_YEARS_OPEN = 5;
const DEFAULT_OWNERSHIP_YEARS = 10;
const EARLIEST_PERMIT_YEAR = 1900;
const DETAIL_HIDDEN = new Set(["source_run_id"]);
const SEARCH_AREA = { south: 29, north: 31, west: -99, east: -96 };

interface Center extends MapCenter {
  name?: string | undefined;
}

const PLACE_OPTIONS = [...PLACES].sort((a, b) => a.name.localeCompare(b.name));
const placeCenter = (name: string): Center => {
  const place = PLACES.find((candidate) => candidate.name === name) ?? PLACES[0];
  return { name: place?.name, latitude: place?.latitude ?? 0, longitude: place?.longitude ?? 0 };
};

export function LeadsPage({ dataset, database }: { dataset: Dataset; database: Database }) {
  const [center, setCenter] = useState<Center>(() => placeCenter(DEFAULT_PLACE));
  const [radius, setRadius] = useState(DEFAULT_RADIUS_MILES);
  const [kind, setKind] = useState(LeadKind.AgedRoofs);
  const [roofAge, setRoofAge] = useState(DEFAULT_ROOF_AGE);
  const [confidence, setConfidence] = useState<(typeof CONFIDENCE_LEVELS)[number]>("low");
  const [yearsOpen, setYearsOpen] = useState(DEFAULT_YEARS_OPEN);
  const [includeExpired, setIncludeExpired] = useState(false);
  const [includeAccessory, setIncludeAccessory] = useState(false);
  const [withContractor, setWithContractor] = useState(false);
  const [issuedSince, setIssuedSince] = useState<number>();
  const [ownershipYears, setOwnershipYears] = useState(DEFAULT_OWNERSHIP_YEARS);
  const [result, setResult] = useState<ToolResult>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [selected, setSelected] = useState<number>();
  const [locating, setLocating] = useState(false);

  const tool = LEAD_KINDS.find((lead) => lead.kind === kind)?.tool ?? "find_aged_roofs";
  const input = useMemo(() => {
    const near = {
      latitude: center.latitude,
      longitude: center.longitude,
      radius_miles: radius,
      limit: MAP_ROWS,
    };
    switch (kind) {
      case LeadKind.AgedRoofs:
        return { ...near, min_roof_age_years: roofAge, min_confidence: confidence };
      case LeadKind.OpenPermits:
        return {
          ...near,
          min_years_open: yearsOpen,
          include_expired: includeExpired,
          include_accessory: includeAccessory,
          with_contractor: withContractor,
          ...(issuedSince && { issued_since_year: issuedSince }),
        };
      case LeadKind.LongHeld:
        return { ...near, min_ownership_years: ownershipYears };
      case LeadKind.OutOfArea:
        return near;
    }
  }, [
    center,
    radius,
    kind,
    roofAge,
    confidence,
    yearsOpen,
    includeExpired,
    includeAccessory,
    withContractor,
    issuedSince,
    ownershipYears,
  ]);

  useEffect(() => {
    let active = true;
    setRunning(true);
    setError(undefined);
    setSelected(undefined);
    runTool(tool, input, { sql: database, dataset: datasetInfo(dataset) }).then(
      (found) => {
        if (!active) return;
        setResult(found);
        setRunning(false);
      },
      (failure: unknown) => {
        if (!active) return;
        setError(failure instanceof Error ? failure.message : String(failure));
        setRunning(false);
      },
    );
    return () => {
      active = false;
    };
  }, [tool, input, database, dataset]);

  const points: MapPoint[] = useMemo(
    () =>
      (result?.rows ?? [])
        .filter((row) => typeof row.latitude === "number" && typeof row.longitude === "number")
        .map((row) => ({
          latitude: row.latitude as number,
          longitude: row.longitude as number,
          label: String(row.situs_address ?? row.address ?? ""),
        })),
    [result],
  );

  const locate = () => {
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords: { latitude, longitude } }) => {
        const insideArea =
          latitude >= SEARCH_AREA.south &&
          latitude <= SEARCH_AREA.north &&
          longitude >= SEARCH_AREA.west &&
          longitude <= SEARCH_AREA.east;
        if (insideArea) setCenter({ name: "My location", latitude, longitude });
        else
          setError(
            `Your location (${latitude.toFixed(3)}, ${longitude.toFixed(3)}) is outside the Travis County search area, so the search stays where it is.`,
          );
        setLocating(false);
      },
      () => {
        setError("The browser did not share a location. Drop a pin on the map instead.");
        setLocating(false);
      },
    );
  };

  const selectedRow = selected === undefined ? undefined : result?.rows[selected];

  return (
    <div className="page">
      <div className="leads-layout">
        <Card title="Search area">
          <div className="controls">
            <label>
              Center on a place
              <select
                value={
                  center.name && PLACES.some((place) => place.name === center.name)
                    ? center.name
                    : ""
                }
                onChange={(event) => setCenter(placeCenter(event.target.value))}
              >
                <option value="" disabled>
                  {center.name ?? "Dropped pin"}
                </option>
                {PLACE_OPTIONS.map((place) => (
                  <option key={place.geoid} value={place.name}>
                    {place.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button secondary" onClick={locate} disabled={locating}>
              {locating ? "Locating…" : "Use my location"}
            </button>
            <p className="muted small">
              Or click the map to drop a pin. Center: {center.latitude.toFixed(5)},{" "}
              {center.longitude.toFixed(5)}
            </p>
            <label>
              Radius: <strong>{radius} miles</strong>
              <input
                type="range"
                min={1}
                max={MAX_RADIUS_MILES}
                step={1}
                value={radius}
                onChange={(event) => setRadius(Number(event.target.value))}
              />
            </label>
            <div className="segmented" role="tablist">
              {LEAD_KINDS.map((lead) => (
                <button
                  key={lead.kind}
                  type="button"
                  role="tab"
                  aria-selected={kind === lead.kind}
                  className={kind === lead.kind ? "active" : ""}
                  onClick={() => setKind(lead.kind)}
                >
                  {lead.label}
                </button>
              ))}
            </div>
            {kind === LeadKind.AgedRoofs && (
              <>
                <label>
                  Roof older than (years)
                  <input
                    type="number"
                    min={0}
                    value={roofAge}
                    onChange={(event) => setRoofAge(Number(event.target.value))}
                  />
                </label>
                <label>
                  Lowest roof-age confidence
                  <select
                    value={confidence}
                    onChange={(event) =>
                      setConfidence(event.target.value as (typeof CONFIDENCE_LEVELS)[number])
                    }
                  >
                    <option value="low">low · year built</option>
                    <option value="medium">medium · new-construction permit</option>
                    <option value="high">high · completed reroof permit</option>
                  </select>
                </label>
              </>
            )}
            {kind === LeadKind.OpenPermits && (
              <>
                <label>
                  Open at least (years)
                  <input
                    type="number"
                    min={0}
                    value={yearsOpen}
                    onChange={(event) => setYearsOpen(Number(event.target.value))}
                  />
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={includeExpired}
                    onChange={(event) => setIncludeExpired(event.target.checked)}
                  />
                  Also permits that expired without a final inspection
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={withContractor}
                    onChange={(event) => setWithContractor(event.target.checked)}
                  />
                  Only permits that list a contractor
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={includeAccessory}
                    onChange={(event) => setIncludeAccessory(event.target.checked)}
                  />
                  Include accessory work (patio covers, sheds)
                </label>
                <label>
                  Issued in or after (year, optional)
                  <input
                    type="number"
                    min={EARLIEST_PERMIT_YEAR}
                    max={new Date().getFullYear()}
                    placeholder="any year"
                    value={issuedSince ?? ""}
                    onChange={(event) =>
                      setIssuedSince(event.target.value ? Number(event.target.value) : undefined)
                    }
                  />
                </label>
              </>
            )}
            {kind === LeadKind.LongHeld && (
              <label>
                Same owner longer than (years)
                <input
                  type="number"
                  min={0}
                  value={ownershipYears}
                  onChange={(event) => setOwnershipYears(Number(event.target.value))}
                />
              </label>
            )}
          </div>
        </Card>
        <div className="map-panel">
          <LeadsMap
            center={center}
            radiusMiles={radius}
            points={points}
            selected={selected}
            onPick={(picked) => setCenter({ ...picked, name: undefined })}
            onSelect={setSelected}
          />
        </div>
      </div>

      <Card
        title={LEAD_KINDS.find((lead) => lead.kind === kind)?.label ?? ""}
        subtitle={
          result && !running ? (
            <>
              <strong>{formatCount(result.totalMatches)}</strong> matches within {radius} miles of{" "}
              {center.name ?? "the pin"}
              {(result.totalMatches ?? 0) > result.rows.length && (
                <>, showing the first {result.rows.length}</>
              )}{" "}
              · answered by DuckDB-WASM in this browser from dataset{" "}
              <Cid cid={dataset.publication.rootCid} />
            </>
          ) : undefined
        }
      >
        {running && <Spinner label="Querying the published Parquet tables…" />}
        {error && <ErrorNote message={error} />}
        {result && !running && (
          <>
            <DataTable
              rows={result.rows}
              columns={COLUMNS[kind]}
              onSelect={(_, index) => setSelected(index)}
              selected={selected}
              empty="Nothing matches within this radius."
            />
            <Disclosure summary="SQL that produced this list">
              <pre className="code-block">{result.sql}</pre>
            </Disclosure>
          </>
        )}
      </Card>

      {selectedRow && <PropertyDetail row={selectedRow} dataset={dataset} database={database} />}
    </div>
  );
}

function PropertyDetail({
  row,
  dataset,
  database,
}: {
  row: Row;
  dataset: Dataset;
  database: Database;
}) {
  const [detail, setDetail] = useState<ToolResult>();
  const [error, setError] = useState<string>();
  const propId = Number(row.prop_id);

  useEffect(() => {
    setDetail(undefined);
    setError(undefined);
    if (!Number.isFinite(propId) || propId <= 0) return;
    runTool(
      "property_details",
      { prop_id: propId },
      { sql: database, dataset: datasetInfo(dataset) },
    ).then(setDetail, (failure: unknown) =>
      setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [propId, database, dataset]);

  const property = detail?.rows[0];
  return (
    <Card
      title={String(row.situs_address ?? row.address ?? "Selected lead")}
      subtitle={
        Number.isFinite(propId) && propId > 0
          ? `TCAD property ${propId}`
          : "No linked TCAD property"
      }
    >
      {row.permit_number !== undefined && (
        <div className="permit-summary">
          <Badge tone="warn">{String(row.permit_state)}</Badge> permit{" "}
          <code>{String(row.permit_number)}</code> open {formatValue(row.years_open)} years ·
          contractor {String(row.contractor_name ?? "not listed")}
          {row.bbb_rating ? (
            <>
              {" "}
              · BBB <Badge tone="good">{String(row.bbb_rating)}</Badge> as of{" "}
              {String(row.bbb_snapshot_date)} ({String(row.bbb_match_confidence)} match)
            </>
          ) : (
            " · no BBB grade found"
          )}
        </div>
      )}
      {error && <ErrorNote message={error} />}
      {property && (
        <dl className="facts columns">
          {Object.entries(property)
            .filter(([key, value]) => value !== null && !DETAIL_HIDDEN.has(key))
            .map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{formatValue(value, key)}</dd>
              </div>
            ))}
        </dl>
      )}
      {detail?.related && (
        <>
          <h3>Roofing permits at this property</h3>
          <DataTable rows={detail.related} empty="No roofing permits recorded." />
        </>
      )}
    </Card>
  );
}
