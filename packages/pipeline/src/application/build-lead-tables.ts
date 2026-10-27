import { type ContractorIdentity, matchContractorsToBbb } from "../domain/bbb-match.js";
import { companyKey, phoneKey } from "../domain/company-name.js";
import { ownerLocality, ownershipYears } from "../domain/owner-signals.js";
import { permitLifecycle } from "../domain/permit-lifecycle.js";
import { estimateRoofAge } from "../domain/roof-age.js";
import { classifyRoofWork } from "../domain/roof-work.js";
import type {
  BuildInputs,
  ClassifiedPermit,
  ContractorKey,
  LeadWarehouse,
  OwnerSignals,
  PropertyRoofAge,
  TableSummary,
} from "./lead-build-ports.js";

export interface BuildOptions {
  buildId: string;
  asOf: string;
  inputs: BuildInputs;
  outputDir: string;
  previousDir: string | undefined;
}

export interface BuildResult {
  buildId: string;
  asOf: string;
  inputs: BuildInputs;
  sourceRows: Record<string, number>;
  roofWork: Record<string, number>;
  roofAgeConfidence: Record<string, number>;
  ownerLocality: Record<string, number>;
  bbbMatches: Record<string, number>;
  tables: TableSummary[];
}

export async function buildLeadTables(
  warehouse: LeadWarehouse,
  { buildId, asOf, inputs, outputDir, previousDir }: BuildOptions,
): Promise<BuildResult> {
  const sourceRows = await warehouse.load(inputs);

  const classified: ClassifiedPermit[] = (await warehouse.permitCandidates()).map((candidate) => {
    const { work, basis } = classifyRoofWork(candidate);
    return {
      permitNumber: candidate.permitNumber,
      roofWork: work,
      roofWorkBasis: basis,
      ...permitLifecycle(candidate, asOf),
    };
  });
  await warehouse.saveClassifiedPermits(classified);

  const roofAges: PropertyRoofAge[] = (await warehouse.roofEvidence()).flatMap((evidence) => {
    const estimate = estimateRoofAge({
      asOf,
      yearBuilt: evidence.yearBuilt,
      permits: evidence.permits,
    });
    return estimate ? [{ propId: evidence.propId, ...estimate }] : [];
  });
  await warehouse.saveRoofAges(roofAges);

  const owners: OwnerSignals[] = (await warehouse.ownerFacts()).map((facts) => ({
    propId: facts.propId,
    locality: ownerLocality(facts.mailing),
    ownershipYears: ownershipYears(facts.deedDate, asOf),
  }));
  await warehouse.saveOwnerSignals(owners);

  const contractorKeys: ContractorKey[] = (await warehouse.contractorNames()).flatMap(
    ({ name, phone }) => {
      const key = companyKey(name);
      return key ? [{ name, phone, contractorKey: key, phoneKey: phoneKey(phone) }] : [];
    },
  );
  await warehouse.saveContractorKeys(contractorKeys);

  const bbbMatches = matchContractorsToBbb(
    contractorIdentities(contractorKeys),
    await warehouse.bbbProfiles(),
  );
  await warehouse.saveBbbMatches(bbbMatches);

  const tables = await warehouse.exportTables(outputDir, previousDir);

  return {
    buildId,
    asOf,
    inputs,
    sourceRows,
    roofWork: countBy(classified, (permit) => permit.roofWork),
    roofAgeConfidence: countBy(roofAges, (roofAge) => roofAge.confidence),
    ownerLocality: countBy(owners, (owner) => owner.locality),
    bbbMatches: countBy(bbbMatches, (match) => match.method),
    tables,
  };
}

function contractorIdentities(keys: readonly ContractorKey[]): ContractorIdentity[] {
  const phones = new Map<string, Set<string>>();
  for (const { contractorKey, phoneKey: phone } of keys) {
    const known = phones.get(contractorKey) ?? new Set<string>();
    if (phone) known.add(phone);
    phones.set(contractorKey, known);
  }
  return [...phones].map(([contractorKey, phoneKeys]) => ({
    contractorKey,
    phoneKeys: [...phoneKeys],
  }));
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
