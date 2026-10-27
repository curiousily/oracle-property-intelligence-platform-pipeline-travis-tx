import type { DatasetInfo } from "@travis-oracle/query-core";

export interface DatasetSourceOptions {
  explorerUrl: string;
  gatewayUrl: string;
  rootCid: string | undefined;
  fetch: typeof fetch;
}

export interface ResolvedDataset {
  info: DatasetInfo;
  rootUrl: string;
  tableUrl(table: string): string;
}

interface Publication {
  buildId: string;
  publishedAt: string;
  manifestCid: string;
  rootCid: string;
}

const PUBLICATIONS_PATH = "/api/publications";

export async function resolveDataset({
  explorerUrl,
  gatewayUrl,
  rootCid,
  fetch: fetchImpl,
}: DatasetSourceOptions): Promise<ResolvedDataset> {
  const getJson = async <T>(url: string): Promise<T> => {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return (await response.json()) as T;
  };
  const located = (info: DatasetInfo & { rootCid: string }): ResolvedDataset => {
    const rootUrl = `${gatewayUrl}/ipfs/${info.rootCid}/`;
    return { info, rootUrl, tableUrl: (table) => `${rootUrl}tables/${table}.parquet` };
  };

  if (rootCid) {
    const build = await getJson<{ buildId: string }>(`${gatewayUrl}/ipfs/${rootCid}/build.json`);
    return located({ buildId: build.buildId, rootCid });
  }

  const publications = await getJson<Publication[]>(`${explorerUrl}${PUBLICATIONS_PATH}`);
  const latest = [...publications].sort((a, b) => a.buildId.localeCompare(b.buildId)).at(-1);
  if (!latest) throw new Error("There is no publication yet.");
  return located({
    buildId: latest.buildId,
    manifestCid: latest.manifestCid,
    rootCid: latest.rootCid,
    publishedAt: latest.publishedAt,
  });
}
