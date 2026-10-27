import { describe, expect, it } from "vitest";
import { canonicalStreetType } from "../../src/domain/street-address.js";

describe("canonicalStreetType", () => {
  it.each([
    ["TERR", "TER"],
    ["BEND", "BND"],
    ["PS", "PASS"],
    ["TR", "TRL"],
    ["CRT", "CT"],
    ["DRIVE", "DR"],
    ["HY", "HWY"],
    ["view", "VW"],
  ])("maps the appraisal roll's %s to the address points' %s", (variant, canonical) => {
    expect(canonicalStreetType(variant)).toBe(canonical);
  });

  it("keeps types that are already canonical", () => {
    expect(canonicalStreetType("DR")).toBe("DR");
    expect(canonicalStreetType(" blvd ")).toBe("BLVD");
  });

  it("treats a missing type as empty", () => {
    expect(canonicalStreetType(undefined)).toBe("");
    expect(canonicalStreetType("  ")).toBe("");
  });
});
