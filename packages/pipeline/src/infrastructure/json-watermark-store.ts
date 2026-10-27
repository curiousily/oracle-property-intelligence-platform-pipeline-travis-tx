import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WatermarkStore } from "../application/ports.js";
import type { SourceId } from "../domain/source-id.js";

const MISSING_FILE = "ENOENT";

type Watermarks = Partial<Record<SourceId, string>>;

export class JsonWatermarkStore implements WatermarkStore {
  constructor(private readonly path: string) {}

  async read(source: SourceId): Promise<string | undefined> {
    return (await this.readAll())[source];
  }

  async write(source: SourceId, watermark: string): Promise<void> {
    const watermarks = await this.readAll();
    watermarks[source] = watermark;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(watermarks, null, 2)}\n`);
  }

  private async readAll(): Promise<Watermarks> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Watermarks;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === MISSING_FILE) return {};
      throw error;
    }
  }
}
