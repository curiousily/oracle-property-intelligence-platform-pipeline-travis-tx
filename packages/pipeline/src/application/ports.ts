import type { FetchReceipt } from "../domain/fetch-receipt.js";
import type { IngestWindow } from "../domain/ingest-window.js";
import type { SourceId } from "../domain/source-id.js";

export interface FetchedPage {
  body: string;
  recordCount: number;
  lastKey: string | undefined;
  maxBusinessDate: string | undefined;
  isLastPage: boolean;
  receipt: FetchReceipt;
}

export interface PagedSource {
  readonly id: SourceId;
  fetchPage(window: IngestWindow, afterKey: string | undefined): Promise<FetchedPage>;
}

export interface RawPage {
  runId: string;
  source: SourceId;
  pageNumber: number;
  body: string;
  receipt: FetchReceipt;
}

export interface RawStore {
  savePage(page: RawPage): Promise<void>;
}

export interface WatermarkStore {
  read(source: SourceId): Promise<string | undefined>;
  write(source: SourceId, watermark: string): Promise<void>;
}
