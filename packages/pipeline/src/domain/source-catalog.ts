import { SourceId } from "./source-id.js";

export interface SourceDescription {
  id: SourceId;
  name: string;
  publisher: string;
  url: string;
  provides: string[];
  refresh: string;
  limitations: string[];
}

export const SOURCE_CATALOG: readonly SourceDescription[] = [
  {
    id: SourceId.AustinPermits,
    name: "Issued Construction Permits",
    publisher: "City of Austin Development Services, Austin Open Data (Socrata)",
    url: "https://data.austintexas.gov/d/3syk-w9eu",
    provides: [
      "permits with type, work class and description",
      "permit status with applied, issued, expiry and completion dates",
      "contractor company name and phone",
      "TCAD parcel id and permit coordinates",
    ],
    refresh:
      "Daily. Re-reads rows whose status, issue or applied date falls on or after the watermark minus a 7-day lookback, keyset-paged by permit number in pages of 50,000.",
    limitations: [
      "Covers permits issued by the City of Austin only; other cities in Travis County and unincorporated areas are not in this dataset.",
      "The city republishes the whole dataset daily (about 14:40–15:05 UTC), so changes are found through business dates rather than a modification timestamp.",
      "Some 50,000-row pages exceed 70 MB of JSON, which needs a 128 MiB parser buffer.",
      "Contractors are free-text company names without license numbers; identities are reconciled by normalized name and phone.",
      "Some permits have no parcel id or a parcel id that is not in the appraisal roll.",
    ],
  },
  {
    id: SourceId.TcadAppraisalExport,
    name: "Appraisal roll export",
    publisher: "Travis Central Appraisal District (TCAD)",
    url: "https://traviscad.org/publicinformation",
    provides: [
      "every appraised property with situs address",
      "owner names and mailing addresses",
      "deed date (ownership duration)",
      "improvements with year built and roof covering",
    ],
    refresh:
      "Checks the export catalog on every run and downloads only a new year or supplement (about 500 MB zip of fixed-width files).",
    limitations: [
      "Published as periodic supplements, not daily.",
      "TCAD web pages refuse some automated clients and regions, while the bulk export files download normally.",
      "Roof age has no direct field: it is taken from completed reroof permits, new-construction permits or the improvement's year built, with a confidence level for each.",
      "Roof covering is coded on the main improvement and missing for part of the roll.",
    ],
  },
  {
    id: SourceId.TcadParcels,
    name: "TCAD Parcels feature layer",
    publisher:
      "Travis Central Appraisal District parcels, hosted by the City of Austin on ArcGIS Online",
    url: "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/EXTERNAL_tcad_parcel/FeatureServer/0",
    provides: ["parcel centroid coordinates by TCAD property id and geo id"],
    refresh:
      "Downloads a new snapshot only when the layer's last edit date changes, 2,000 features per page.",
    limitations: [
      "Condominium units and mobile homes share one parcel, so they are located through the shared parcel, county address points or permit coordinates.",
      "A centroid marks the parcel, not the roof itself.",
    ],
  },
  {
    id: SourceId.TravisAddressPoints,
    name: "Address Points feature layer",
    publisher: "City of Austin Communications and Technology Management, 9-1-1 Addressing",
    url: "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/LOCATION_address_points/FeatureServer/0",
    provides: ["address point coordinates used for properties without their own parcel"],
    refresh:
      "Downloads a new snapshot only when the layer's last edit date changes, 2,000 features per page.",
    limitations: [
      "Addresses are matched by normalized street address; an address is used only when its points agree within about 400 m.",
    ],
  },
  {
    id: SourceId.BbbArchive,
    name: "Archived BBB business profiles",
    publisher: "Internet Archive Wayback Machine captures of bbb.org",
    url: "https://web.archive.org/web/*/bbb.org/us/tx/*",
    provides: [
      "BBB letter grade and accreditation of Austin-area contractors",
      "business name, alternate names and phone used for matching",
      "snapshot date and archive URL of every grade",
    ],
    refresh:
      "Lists captures from the Wayback CDX index and fetches only captures not archived yet, within a time budget per run, profiles of known contractors first.",
    limitations: [
      "bbb.org refuses automated clients and has no public API, so grades come only from archived snapshots and are shown as of the snapshot date.",
      "Only profiles the Internet Archive captured are available.",
      "The CDX index and snapshots are slow, so each run fetches a bounded number of profiles at one request per second.",
      "Contractor matching by name and phone is heuristic and carries a match confidence.",
    ],
  },
];
