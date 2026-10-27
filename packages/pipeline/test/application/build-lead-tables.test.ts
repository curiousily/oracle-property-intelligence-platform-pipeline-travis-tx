import { describe, expect, it } from "vitest";
import { buildLeadTables } from "../../src/application/build-lead-tables.js";
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
} from "../../src/application/lead-build-ports.js";
import { OwnerLocality } from "../../src/domain/owner-signals.js";
import { PermitState } from "../../src/domain/permit-state.js";
import { Confidence, RoofAnchor } from "../../src/domain/roof-age.js";
import { RoofWork } from "../../src/domain/roof-work.js";

const AS_OF = "2026-10-27";
const INPUTS: BuildInputs = {
  permitPages: "/data/raw/austin-permits/*/page-*.json.gz",
  appraisalTablesDir: "/data/tables/tcad-appraisal-export/20261027T100000Z",
  parcelPages: "/data/raw/tcad-parcels/20261027T110000Z/page-*.json.gz",
};

const candidate = (overrides: Partial<PermitCandidate>): PermitCandidate => ({
  permitNumber: "2016-023376 BP",
  permitType: "BP",
  workClass: "Repair",
  permitClass: "R- 434 Addition & Alterations",
  description: "Replace roof shingles on sf res.",
  status: "Active",
  appliedDate: "2016-03-01",
  issueDate: "2016-03-03",
  completedDate: undefined,
  expiresDate: "2017-01-02",
  ...overrides,
});

class FakeWarehouse implements LeadWarehouse {
  loadedFrom: BuildInputs | undefined;
  classified: readonly ClassifiedPermit[] = [];
  roofAges: readonly PropertyRoofAge[] = [];
  ownerSignals: readonly OwnerSignals[] = [];
  contractorKeys: readonly ContractorKey[] = [];
  exportedTo: { outputDir: string; previousDir: string | undefined } | undefined;

  async load(inputs: BuildInputs) {
    this.loadedFrom = inputs;
    return { permits: 3, properties: 2, parcels: 2 };
  }
  async permitCandidates(): Promise<PermitCandidate[]> {
    return [
      candidate({}),
      candidate({
        permitNumber: "2010-000002 BP",
        description: "Re-roof residence",
        status: "Final",
        completedDate: "2010-10-28",
      }),
      candidate({ permitNumber: "2020-000003 BP", description: "Kitchen remodel" }),
    ];
  }
  async saveClassifiedPermits(rows: readonly ClassifiedPermit[]) {
    this.classified = rows;
  }
  async roofEvidence(): Promise<PropertyRoofEvidence[]> {
    return [
      {
        propId: 100008,
        yearBuilt: 1984,
        permits: [
          {
            permitNumber: "2010-000002 BP",
            work: RoofWork.Replacement,
            state: PermitState.Completed,
            completedDate: "2010-10-28",
          },
        ],
      },
      { propId: 100012, yearBuilt: undefined, permits: [] },
    ];
  }
  async saveRoofAges(rows: readonly PropertyRoofAge[]) {
    this.roofAges = rows;
  }
  async ownerFacts(): Promise<OwnerFacts[]> {
    return [
      {
        propId: 100008,
        mailing: { state: "CA", zip: "94105", country: undefined },
        deedDate: "2011-11-22",
      },
    ];
  }
  async saveOwnerSignals(rows: readonly OwnerSignals[]) {
    this.ownerSignals = rows;
  }
  async contractorNames(): Promise<ContractorName[]> {
    return [
      { name: "RELIABLE ROOFING OF TEXAS INC", phone: "(512) 555-0142" },
      { name: "  ", phone: undefined },
    ];
  }
  async saveContractorKeys(rows: readonly ContractorKey[]) {
    this.contractorKeys = rows;
  }
  async exportTables(outputDir: string, previousDir: string | undefined): Promise<TableSummary[]> {
    this.exportedTo = { outputDir, previousDir };
    return [{ table: "properties", rows: 2, added: 2, changed: 0, removed: 0 }];
  }
}

async function build(warehouse = new FakeWarehouse()) {
  const result = await buildLeadTables(warehouse, {
    buildId: "20261027T120000Z",
    asOf: AS_OF,
    inputs: INPUTS,
    outputDir: "/data/build/20261027T120000Z",
    previousDir: "/data/build/20261026T120000Z",
  });
  return { warehouse, result };
}

describe("buildLeadTables", () => {
  it("classifies every candidate permit's roof work and lifecycle as of the build date", async () => {
    const { warehouse } = await build();

    expect(warehouse.classified).toEqual([
      {
        permitNumber: "2016-023376 BP",
        roofWork: RoofWork.Replacement,
        roofWorkBasis: "REPLACE ROOF",
        state: PermitState.Open,
        unfinished: true,
        openSince: "2016-03-03",
        yearsOpen: 10,
        pastExpiry: true,
      },
      expect.objectContaining({
        permitNumber: "2010-000002 BP",
        roofWork: RoofWork.Replacement,
        state: PermitState.Completed,
        unfinished: false,
      }),
      expect.objectContaining({ permitNumber: "2020-000003 BP", roofWork: RoofWork.Unrelated }),
    ]);
  });

  it("estimates roof age only for properties with evidence", async () => {
    const { warehouse } = await build();

    expect(warehouse.roofAges).toEqual([
      {
        propId: 100008,
        anchor: RoofAnchor.CompletedReplacement,
        anchorDate: "2010-10-28",
        anchorPermitNumber: "2010-000002 BP",
        estimatedAgeYears: 15,
        confidence: Confidence.High,
      },
    ]);
  });

  it("derives owner locality and ownership years", async () => {
    const { warehouse } = await build();

    expect(warehouse.ownerSignals).toEqual([
      { propId: 100008, locality: OwnerLocality.OutOfState, ownershipYears: 14 },
    ]);
  });

  it("keys contractors by normalized name and phone, skipping blank names", async () => {
    const { warehouse } = await build();

    expect(warehouse.contractorKeys).toEqual([
      {
        name: "RELIABLE ROOFING OF TEXAS INC",
        phone: "(512) 555-0142",
        contractorKey: "reliable roofing",
        phoneKey: "5125550142",
      },
    ]);
  });

  it("exports the tables against the previous build and reports what it built", async () => {
    const { warehouse, result } = await build();

    expect(warehouse.loadedFrom).toEqual(INPUTS);
    expect(warehouse.exportedTo).toEqual({
      outputDir: "/data/build/20261027T120000Z",
      previousDir: "/data/build/20261026T120000Z",
    });
    expect(result).toEqual({
      buildId: "20261027T120000Z",
      asOf: AS_OF,
      inputs: INPUTS,
      sourceRows: { permits: 3, properties: 2, parcels: 2 },
      roofWork: { [RoofWork.Replacement]: 2, [RoofWork.Unrelated]: 1 },
      roofAgeConfidence: { [Confidence.High]: 1 },
      ownerLocality: { [OwnerLocality.OutOfState]: 1 },
      tables: [{ table: "properties", rows: 2, added: 2, changed: 0, removed: 0 }],
    });
  });
});
