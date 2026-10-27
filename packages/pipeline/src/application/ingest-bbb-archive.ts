import { latestCapturePerProfile } from "../domain/bbb-profile.js";
import { SourceId } from "../domain/source-id.js";
import { laterWatermark } from "../domain/watermark.js";
import type {
  ArchivedProfileRecord,
  ArchiveIndex,
  BbbArchiveStore,
  ProfileParser,
  SnapshotFetcher,
} from "./bbb-ports.js";
import type { WatermarkStore } from "./ports.js";

export interface BbbArchiveDependencies {
  index: ArchiveIndex;
  snapshots: SnapshotFetcher;
  parser: ProfileParser;
  store: BbbArchiveStore;
  watermarks: WatermarkStore;
}

export interface BbbArchiveOptions {
  runId: string;
  state: string;
  categories: readonly string[];
}

export interface BbbArchiveResult {
  source: SourceId;
  runId: string;
  previousWatermark: string | undefined;
  watermark: string | undefined;
  captures: number;
  profiles: number;
  parsed: number;
  unparsed: number;
  failed: number;
  ratings: Record<string, number>;
}

export async function ingestBbbArchive(
  { index, snapshots, parser, store, watermarks }: BbbArchiveDependencies,
  { runId, state, categories }: BbbArchiveOptions,
): Promise<BbbArchiveResult> {
  const source = SourceId.BbbArchive;
  const previousWatermark = await watermarks.read(source);
  const captures = await index.captures({ state, categories, since: previousWatermark });
  const fresh = latestCapturePerProfile(captures).filter(
    (capture) => previousWatermark === undefined || capture.timestamp > previousWatermark,
  );

  let parsed = 0;
  let unparsed = 0;
  let failed = 0;
  const ratings: Record<string, number> = {};
  for (const capture of fresh) {
    let record: ArchivedProfileRecord;
    try {
      const snapshot = await snapshots.fetch(capture);
      const profile = parser.parse(snapshot.body, capture) ?? null;
      record = { profileId: capture.profileId, capture, receipt: snapshot.receipt, profile };
      if (profile === null) unparsed += 1;
      else {
        parsed += 1;
        if (profile.rating) ratings[profile.rating] = (ratings[profile.rating] ?? 0) + 1;
      }
    } catch (error) {
      failed += 1;
      record = {
        profileId: capture.profileId,
        capture,
        profile: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await store.append(runId, record);
  }

  const watermark = captures.reduce<string | undefined>(
    (latest, capture) => laterWatermark(latest, capture.timestamp),
    previousWatermark,
  );
  if (watermark !== undefined && watermark !== previousWatermark) {
    await watermarks.write(source, watermark);
  }

  return {
    source,
    runId,
    previousWatermark,
    watermark,
    captures: captures.length,
    profiles: fresh.length,
    parsed,
    unparsed,
    failed,
    ratings,
  };
}
