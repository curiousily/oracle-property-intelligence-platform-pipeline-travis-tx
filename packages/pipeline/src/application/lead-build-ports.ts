import type { BbbMatch } from "../domain/bbb-match.js";
import type { BbbProfile } from "../domain/bbb-profile.js";
import type { MailingAddress, OwnerLocality } from "../domain/owner-signals.js";
import type { PermitDates, PermitLifecycle } from "../domain/permit-lifecycle.js";
import type { RoofAgeEstimate, RoofPermitEvidence } from "../domain/roof-age.js";
import type { PermitFacts, RoofWork } from "../domain/roof-work.js";

export interface BuildInputs {
  permitPages: string;
  appraisalTablesDir: string;
  parcelPages: string;
  addressPointPages?: string;
  bbbProfiles?: string;
}

export interface PermitCandidate extends PermitFacts, PermitDates {
  permitNumber: string;
  completedDate: string | undefined;
}

export interface ClassifiedPermit extends PermitLifecycle {
  permitNumber: string;
  roofWork: RoofWork;
  roofWorkBasis: string;
}

export interface PropertyRoofEvidence {
  propId: number;
  yearBuilt: number | undefined;
  permits: RoofPermitEvidence[];
}

export interface PropertyRoofAge extends RoofAgeEstimate {
  propId: number;
}

export interface OwnerFacts {
  propId: number;
  mailing: MailingAddress;
  deedDate: string | undefined;
}

export interface OwnerSignals {
  propId: number;
  locality: OwnerLocality;
  ownershipYears: number | undefined;
}

export interface ContractorName {
  name: string | undefined;
  phone: string | undefined;
}

export interface ContractorKey {
  name: string | undefined;
  phone: string | undefined;
  contractorKey: string;
  phoneKey: string | undefined;
}

export interface TableSummary {
  table: string;
  rows: number;
  added: number;
  changed: number;
  removed: number;
}

export interface LeadWarehouse {
  load(inputs: BuildInputs): Promise<Record<string, number>>;
  permitCandidates(): Promise<PermitCandidate[]>;
  saveClassifiedPermits(rows: readonly ClassifiedPermit[]): Promise<void>;
  roofEvidence(): Promise<PropertyRoofEvidence[]>;
  saveRoofAges(rows: readonly PropertyRoofAge[]): Promise<void>;
  ownerFacts(): Promise<OwnerFacts[]>;
  saveOwnerSignals(rows: readonly OwnerSignals[]): Promise<void>;
  contractorNames(): Promise<ContractorName[]>;
  saveContractorKeys(rows: readonly ContractorKey[]): Promise<void>;
  bbbProfiles(): Promise<BbbProfile[]>;
  saveBbbMatches(rows: readonly BbbMatch[]): Promise<void>;
  exportTables(outputDir: string, previousDir: string | undefined): Promise<TableSummary[]>;
}
