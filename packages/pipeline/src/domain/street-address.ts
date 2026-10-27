export const STREET_TYPE_ALIASES: Readonly<Record<string, string>> = {
  AV: "AVE",
  BEND: "BND",
  BL: "BLVD",
  CR: "CIR",
  CRT: "CT",
  DRIVE: "DR",
  HY: "HWY",
  LP: "LOOP",
  PKY: "PKWY",
  PS: "PASS",
  PTH: "PATH",
  TERR: "TER",
  TR: "TRL",
  TRACE: "TRCE",
  VIEW: "VW",
};

export const MAX_ADDRESS_POINT_SPREAD_DEGREES = 0.004;

export function canonicalStreetType(type: string | undefined): string {
  const normalized = type?.trim().toUpperCase() ?? "";
  return STREET_TYPE_ALIASES[normalized] ?? normalized;
}
