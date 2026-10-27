import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ArchivedProfileRecord, BbbArchiveStore } from "../application/bbb-ports.js";
import { SourceId } from "../domain/source-id.js";
import { RAW_DIR } from "./file-raw-store.js";

export const BBB_ARCHIVE_FILE = "profiles.ndjson";

export class NdjsonBbbArchiveStore implements BbbArchiveStore {
  constructor(private readonly dataDir: string) {}

  async append(runId: string, record: ArchivedProfileRecord): Promise<void> {
    const runDir = join(this.dataDir, RAW_DIR, SourceId.BbbArchive, runId);
    await mkdir(runDir, { recursive: true });
    await appendFile(join(runDir, BBB_ARCHIVE_FILE), `${JSON.stringify(record)}\n`);
  }
}
