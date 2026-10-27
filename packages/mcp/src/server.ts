import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type DatasetInfo, runTool, TOOLS } from "@travis-oracle/query-core";
import { z } from "zod";
import type { DuckDbRunner } from "./duckdb-runner.js";

const SERVER_NAME = "travis-oracle";
const SERVER_VERSION = "1.0.0";
const DEFAULT_SQL_ROWS = 200;
const MAX_SQL_ROWS = 1_000;
const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export interface ServerDependencies {
  sql: Pick<DuckDbRunner, "all" | "readOnly">;
  dataset: DatasetInfo;
}

export function createServer({ sql, dataset }: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: `Travis County, TX property intelligence for roofing leads: TCAD properties and owners, City of Austin permits, contractors with archived BBB grades and coordinates, published on IPFS as dataset ${dataset.rootCid ?? dataset.buildId}. Tables: properties, roofing_permits, contractors, permits. Prefer the find_* tools; use run_sql for anything else.`,
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: READ_ONLY },
      (input) => answer(() => runTool(tool.name, input, { sql, dataset })),
    );
  }

  server.registerTool(
    "run_sql",
    {
      description:
        "Run one read-only DuckDB SELECT over the published tables properties, roofing_permits, contractors and permits.",
      inputSchema: z.object({
        sql: z.string().min(1).describe("One SELECT statement."),
        max_rows: z.number().int().positive().max(MAX_SQL_ROWS).default(DEFAULT_SQL_ROWS),
      }),
      annotations: READ_ONLY,
    },
    ({ sql: query, max_rows: maxRows }) =>
      answer(async () => ({ rows: await sql.readOnly(query, maxRows), dataset })),
  );

  return server;
}

async function answer(run: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await run()) }] };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
}
