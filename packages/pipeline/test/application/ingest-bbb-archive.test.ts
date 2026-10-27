import { describe, expect, it } from "vitest";
import type {
  ArchivedProfileRecord,
  ArchiveIndex,
  BbbArchiveStore,
  CaptureQuery,
  ProfileParser,
  SnapshotFetcher,
} from "../../src/application/bbb-ports.js";
import { ingestBbbArchive } from "../../src/application/ingest-bbb-archive.js";
import type { WatermarkStore } from "../../src/application/ports.js";
import { type ArchiveCapture, type BbbProfile, BbbRating } from "../../src/domain/bbb-profile.js";
import { SourceId } from "../../src/domain/source-id.js";

const RUN_ID = "20261028T090000Z";
const ACME = "https://www.bbb.org/us/tx/austin/profile/roofing-contractors/acme-roofing-0825-1";
const BETA = "https://www.bbb.org/us/tx/austin/profile/roofing-contractors/beta-roofing-0825-2";
const GONE = "https://www.bbb.org/us/tx/austin/profile/roofing-contractors/gone-roofing-0825-3";

const receipt = {
  url: "https://web.archive.org/web/x",
  fetchedAt: "2026-10-28T09:00:00.000Z",
  httpStatus: 200,
  bytes: 10,
  sha256: "abc",
};

class FixedIndex implements ArchiveIndex {
  queries: CaptureQuery[] = [];
  constructor(private readonly answer: ArchiveCapture[]) {}
  async captures(query: CaptureQuery) {
    this.queries.push(query);
    return this.answer;
  }
}

class FakeSnapshots implements SnapshotFetcher {
  fetched: ArchiveCapture[] = [];
  async fetch(capture: ArchiveCapture) {
    this.fetched.push(capture);
    if (capture.originalUrl === GONE) throw new Error("HTTP 404");
    return {
      body: capture.originalUrl === BETA ? "<html>no state</html>" : "<html>state</html>",
      receipt,
    };
  }
}

class StateParser implements ProfileParser {
  parse(
    html: string,
    capture: { profileId: string; originalUrl: string; timestamp: string },
  ): BbbProfile | undefined {
    if (!html.includes(">state<")) return undefined;
    return {
      profileId: capture.profileId,
      name: "Acme Roofing",
      alternateNames: [],
      phones: [],
      city: "Austin",
      state: "TX",
      zip: "78704",
      rating: BbbRating.A,
      accredited: true,
      accreditedSince: undefined,
      outOfBusiness: false,
      profileUrl: capture.originalUrl,
      snapshotUrl: `https://web.archive.org/web/${capture.timestamp}/${capture.originalUrl}`,
      snapshotAt: "2026-07-10T20:33:09Z",
    };
  }
}

class MemoryStore implements BbbArchiveStore {
  records: ArchivedProfileRecord[] = [];
  async append(runId: string, record: ArchivedProfileRecord) {
    expect(runId).toBe(RUN_ID);
    this.records.push(record);
  }
}

class MemoryWatermarks implements WatermarkStore {
  constructor(readonly values = new Map<SourceId, string>()) {}
  async read(source: SourceId) {
    return this.values.get(source);
  }
  async write(source: SourceId, watermark: string) {
    this.values.set(source, watermark);
  }
}

function setup(captures: ArchiveCapture[], watermarks = new MemoryWatermarks()) {
  return {
    index: new FixedIndex(captures),
    snapshots: new FakeSnapshots(),
    parser: new StateParser(),
    store: new MemoryStore(),
    watermarks,
  };
}

const options = { runId: RUN_ID, state: "tx", categories: ["roofing-contractors"] };

describe("ingestBbbArchive", () => {
  it("fetches only the newest capture of each profile and keeps every outcome with its receipt", async () => {
    const deps = setup([
      { originalUrl: ACME, timestamp: "20210101000000" },
      { originalUrl: ACME, timestamp: "20260710203309" },
      { originalUrl: BETA, timestamp: "20250101000000" },
      { originalUrl: GONE, timestamp: "20240101000000" },
    ]);

    const result = await ingestBbbArchive(deps, options);

    expect(deps.snapshots.fetched.map((capture) => capture.timestamp)).toEqual([
      "20260710203309",
      "20250101000000",
      "20240101000000",
    ]);
    expect(deps.store.records.map((record) => [record.profileId, record.profile !== null])).toEqual(
      [
        ["0825-1", true],
        ["0825-2", false],
        ["0825-3", false],
      ],
    );
    expect(deps.store.records[0]?.receipt).toEqual(receipt);
    expect(deps.store.records[2]?.error).toContain("404");
    expect(result).toEqual({
      source: SourceId.BbbArchive,
      runId: RUN_ID,
      previousWatermark: undefined,
      watermark: "20260710203309",
      captures: 4,
      profiles: 3,
      parsed: 1,
      unparsed: 1,
      failed: 1,
      ratings: { A: 1 },
    });
  });

  it("asks the archive only for captures since the last run and skips ones already seen", async () => {
    const watermarks = new MemoryWatermarks(new Map([[SourceId.BbbArchive, "20260710203309"]]));
    const deps = setup(
      [
        { originalUrl: ACME, timestamp: "20260710203309" },
        { originalUrl: BETA, timestamp: "20261001000000" },
      ],
      watermarks,
    );

    const result = await ingestBbbArchive(deps, options);

    expect(deps.index.queries).toEqual([
      { state: "tx", categories: ["roofing-contractors"], since: "20260710203309" },
    ]);
    expect(deps.snapshots.fetched.map((capture) => capture.originalUrl)).toEqual([BETA]);
    expect(result.watermark).toBe("20261001000000");
  });
});
