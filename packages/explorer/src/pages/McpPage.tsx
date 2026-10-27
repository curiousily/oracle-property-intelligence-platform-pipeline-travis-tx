import { runTool, type ToolResult, toolSchemas } from "@travis-oracle/query-core";
import { useState } from "react";
import { Card, DataTable, Disclosure, ErrorNote, Spinner } from "../components/ui.js";
import type { Dataset } from "../data/dataset.js";
import type { Database } from "../data/duckdb.js";
import { datasetInfo } from "./dataset-info.js";

const SCHEMAS = toolSchemas();
const REPOSITORY_URL =
  "https://github.com/curiousily/oracle-property-intelligence-platform-pipeline-travis-tx";
const EXAMPLE_INPUTS: Record<string, object> = {
  find_aged_roofs: { place: "Pflugerville", radius_miles: 5, min_roof_age_years: 15, limit: 10 },
  find_open_roofing_permits: {
    place: "Pflugerville",
    radius_miles: 5,
    min_years_open: 5,
    limit: 10,
  },
  property_details: { prop_id: 100036 },
  contractor_details: { name: "roof" },
  find_long_held_properties: {
    place: "Lakeway",
    radius_miles: 3,
    min_ownership_years: 10,
    limit: 10,
  },
  find_out_of_area_owners: { place: "Manor", radius_miles: 2, limit: 10 },
  locate_place: { name: "Bee Cave" },
  dataset_summary: {},
};
const MCP_SETUP = `git clone ${REPOSITORY_URL}
cd oracle-property-intelligence-platform-pipeline-travis-tx
git checkout travis-pipeline && npm ci

# Claude Code
claude mcp add travis-oracle -- npm run --silent mcp --prefix "$PWD"

# Any MCP client (stdio)
npm run --silent mcp`;

export function McpPage({ dataset, database }: { dataset: Dataset; database: Database }) {
  const [tool, setTool] = useState(SCHEMAS[0]?.name ?? "");
  const [input, setInput] = useState(JSON.stringify(EXAMPLE_INPUTS[tool] ?? {}, null, 2));
  const [result, setResult] = useState<ToolResult>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);

  const choose = (name: string) => {
    setTool(name);
    setInput(JSON.stringify(EXAMPLE_INPUTS[name] ?? {}, null, 2));
    setResult(undefined);
    setError(undefined);
  };

  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      setResult(
        await runTool(tool, JSON.parse(input), { sql: database, dataset: datasetInfo(dataset) }),
      );
    } catch (failure) {
      setResult(undefined);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page">
      <Card
        title="MCP-ready query interface"
        subtitle="The same tool definitions back the explorer, the agent, the MCP server and the roofing CRM, so clients query one data model through validated tools."
      >
        <div className="mcp-layout">
          <div>
            <h3>Tools</h3>
            <ul className="tool-list">
              {SCHEMAS.map((schema) => (
                <li key={schema.name}>
                  <button
                    type="button"
                    className={schema.name === tool ? "tool active" : "tool"}
                    onClick={() => choose(schema.name)}
                  >
                    <code>{schema.name}</code>
                    <span>{schema.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>
              Try <code>{tool}</code>
            </h3>
            <textarea
              aria-label="Tool input"
              className="json-input"
              value={input}
              spellCheck={false}
              onChange={(event) => setInput(event.target.value)}
            />
            <button type="button" className="button" onClick={run} disabled={running}>
              Call tool
            </button>
            {running && <Spinner label="Running…" />}
            {error && <ErrorNote message={error} />}
            {result && (
              <>
                <DataTable rows={result.rows} />
                {result.related && result.related.length > 0 && <DataTable rows={result.related} />}
                <Disclosure summary="Tool result as an MCP client receives it">
                  <pre className="code-block">{JSON.stringify(result, null, 2)}</pre>
                </Disclosure>
              </>
            )}
            <Disclosure summary="Input JSON Schema">
              <pre className="code-block">
                {JSON.stringify(
                  SCHEMAS.find((schema) => schema.name === tool)?.inputSchema,
                  null,
                  2,
                )}
              </pre>
            </Disclosure>
          </div>
        </div>
      </Card>
      <Card
        title="Connect an MCP client"
        subtitle="The stdio MCP server runs the same tools with DuckDB over the published Parquet tables; it resolves the latest publication by CID."
      >
        <pre className="code-block">{MCP_SETUP}</pre>
      </Card>
    </div>
  );
}
