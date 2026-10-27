import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawPage, RawStore } from "../application/ports.js";

const RAW_DIR = "raw";
const RECEIPTS_FILE = "receipts.ndjson";
const PAGE_NUMBER_WIDTH = 5;

export class FileRawStore implements RawStore {
  constructor(private readonly dataDir: string) {}

  async savePage({ runId, source, pageNumber, body, receipt }: RawPage): Promise<void> {
    const runDir = join(this.dataDir, RAW_DIR, source, runId);
    await mkdir(runDir, { recursive: true });

    const file = `page-${String(pageNumber).padStart(PAGE_NUMBER_WIDTH, "0")}.json`;
    await writeFile(join(runDir, file), body);
    await appendFile(
      join(runDir, RECEIPTS_FILE),
      `${JSON.stringify({ pageNumber, file, ...receipt })}\n`,
    );
  }
}
