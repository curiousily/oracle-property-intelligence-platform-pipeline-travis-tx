import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "@playwright/test";

const EXPLORER_URL =
  process.env.EXPLORER_URL ?? "https://travis-oracle-explorer.curiousily.workers.dev";
const OUTPUT_DIR = process.env.DEMO_DIR ?? "demo/output";
const VIEWPORT = { width: 1440, height: 900 };
const READ_MS = 4_500;
const LONG_READ_MS = 7_000;
const SETTLE_MS = 1_500;
const DATA_TIMEOUT_MS = 120_000;
const AGENT_TIMEOUT_MS = 180_000;
const PLACE = "Rollingwood";
const AGENT_PLACE = "West Lake Hills";

const CAPTION_SCRIPT = `
  window.demoCaption = (title, body) => {
    let box = document.getElementById("demo-caption");
    if (!box) {
      box = document.createElement("div");
      box.id = "demo-caption";
      box.style.cssText = "position:fixed;left:50%;top:6px;transform:translateX(-50%);width:min(1100px,96vw);z-index:99999;" +
        "background:rgba(17,20,24,.94);color:#fff;padding:10px 20px;border-radius:10px;font:14px/1.4 Inter,system-ui,sans-serif;" +
        "box-shadow:0 8px 30px rgba(0,0,0,.35)";
      document.body.appendChild(box);
    }
    box.innerHTML = "<div style='font-weight:700;font-size:16px;margin-bottom:4px'>" + title + "</div><div>" + body + "</div>";
  };
`;

async function caption(page: Page, title: string, body: string, pauseMs = READ_MS) {
  await page.evaluate(
    ({ heading, text }) =>
      (window as unknown as { demoCaption(a: string, b: string): void }).demoCaption(heading, text),
    { heading: title, text: body },
  );
  await page.waitForTimeout(pauseMs);
}

async function show(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element) =>
    element.scrollIntoView({ behavior: "smooth", block: "start" }),
  );
  await locator.page().waitForTimeout(SETTLE_MS);
}

async function open(page: Page, hash: string) {
  await page.goto(`${EXPLORER_URL}/#/${hash}`);
  await page.getByText(/^Dataset \d{8}T\d{6}Z$/).waitFor({ timeout: DATA_TIMEOUT_MS });
}

async function record() {
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUTPUT_DIR, size: VIEWPORT },
  });
  await context.addInitScript(CAPTION_SCRIPT);
  const page = await context.newPage();

  await open(page, "overview");
  await caption(
    page,
    "Travis County Oracle",
    "The pipeline has loaded Travis County, TX property, permit, ownership, contractor, BBB and coordinate data, published it to IPFS as content-addressed snapshots, and serves it to a UI, an agent and MCP clients.",
    LONG_READ_MS,
  );
  await caption(
    page,
    "Pipeline run summary",
    "The latest build: 453,713 properties, 2.4 million permits, 37,613 roofing permits, 6,062 reconciled contractors, 98% of properties located.",
  );
  await show(page.getByRole("heading", { name: "Records by kind" }));
  await caption(
    page,
    "Records by source",
    "Property, permit, ownership, contractor (with BBB grade), business and coordinate records, each with its source and collection time.",
    LONG_READ_MS,
  );
  await show(page.getByRole("heading", { name: "Sources" }));
  await caption(
    page,
    "Documented source limitations",
    "Every source's publisher, refresh strategy and known constraints ship inside each published snapshot (sources.json).",
    LONG_READ_MS,
  );
  await show(page.getByRole("heading", { name: "Run history" }));
  await caption(
    page,
    "Continuous, incremental runs",
    "Every daily ingest, build (with row deltas) and weekly publication, newest first. Unchanged sources are detected and skipped.",
    LONG_READ_MS,
  );
  await show(page.getByRole("heading", { name: "Infrastructure and cost" }));
  await caption(
    page,
    "No infrastructure cost for Oracle",
    "GitHub Actions, Cloudflare free plans, DuckDB in the browser and free IPFS pinning: nothing to pay for by default.",
  );

  await open(page, "sql");
  await caption(
    page,
    "DuckDB-backed query layer",
    "DuckDB-WASM runs in this browser and reads the published Parquet tables with HTTP range requests. No database server.",
  );
  await page.getByRole("button", { name: "Run query" }).click();
  await page.locator(".data-table tbody tr").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(page, "Rows per table", "Counted directly over the published Parquet files.");
  await page
    .getByRole("button", { name: "Busiest roofing contractors and their BBB grades" })
    .click();
  await page.locator(".data-table tbody tr").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "Contractors with BBB grades",
    "Contractors reconciled from permit names and phones, matched to archived BBB profiles with a method and confidence.",
    LONG_READ_MS,
  );

  await open(page, "publication");
  await caption(
    page,
    "Artifact manifest",
    "Every published object with its CIDv1, logical name, size, codec and SHA-256. Gateway links are derived from the CIDs.",
    LONG_READ_MS,
  );
  await show(page.getByRole("heading", { name: "Objects" }));
  await page.waitForTimeout(READ_MS);
  const coverage = page.locator("tr").filter({ hasText: "coverage.json" });
  await coverage.getByRole("button", { name: /verify/ }).click();
  await coverage.getByText("gw.ipfs-lens.dev: verified").waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "Retrieved from two independent public gateways",
    "coverage.json fetched by CID from ipfs.orbitor.dev and gw.ipfs-lens.dev in this browser; size and SHA-256 match the manifest.",
    LONG_READ_MS,
  );
  await show(page.getByRole("heading", { name: "Artifact manifest" }));
  await page.getByRole("button", { name: /Resolve now/ }).click();
  await page.getByText(/resolves to/).waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "IPNS points at the latest manifest",
    "The IPNS name resolves live to the newest manifest CID. IPNS is the pointer; the CID is the snapshot. A CAR of the root DAG is on GitHub Releases.",
    LONG_READ_MS,
  );
  await show(page.getByRole("heading", { name: "Publication history" }));
  const roots = await page.getByRole("button", { name: "check root" }).all();
  for (const button of roots) await button.click();
  await page.waitForFunction(() => !document.body.textContent?.includes("checking…"), undefined, {
    timeout: DATA_TIMEOUT_MS,
  });
  await caption(
    page,
    "Incremental publications, immutable CIDs",
    "Each publication has its own CIDs; earlier roots still resolve on the public gateways and each manifest links its predecessor.",
    LONG_READ_MS,
  );

  await open(page, "leads");
  await page.getByLabel("Center on a place").selectOption(PLACE);
  await page
    .locator(".card")
    .filter({ hasText: "matches within" })
    .locator("tbody tr")
    .first()
    .waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    `Roofs older than 15 years within 5 miles of ${PLACE}`,
    "Best-evidenced first: completed reroof permit, then new-construction permit, then year built. Each row has its coordinates and source.",
    LONG_READ_MS,
  );
  const results = page.locator(".card").filter({ hasText: "matches within" });
  await show(results);
  await page.waitForTimeout(READ_MS);
  await show(page.getByRole("tab", { name: "Aged roofs" }));
  await page.getByRole("tab", { name: "Open roofing permits" }).click();
  await results.locator("tbody tr").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "Open roofing permits, longest open first",
    "Permits that are still open five years or more, with years open, contractor and BBB grade, linked to the city's permit record.",
    LONG_READ_MS,
  );
  await page.getByLabel(/Also permits that expired/).check();
  await page.getByLabel(/Only permits that list a contractor/).check();
  await results.locator("tbody tr").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
  await show(results);
  await caption(
    page,
    "Never finished, with a listed contractor",
    "Adding permits that expired without a final inspection, and keeping those that list a contractor, brings in archived BBB grades.",
    LONG_READ_MS,
  );
  const graded = results
    .locator("tbody tr")
    .filter({ hasText: /\bA\+|\bA-|\bB\+/ })
    .first();
  await graded.click();
  await page.waitForTimeout(SETTLE_MS);
  await caption(
    page,
    "Permit detail",
    "Status, open duration, contractor and BBB grade with its archived snapshot date.",
    LONG_READ_MS,
  );

  await open(page, "agent");
  await caption(
    page,
    "The same questions through the agent",
    "A Workers AI model picks the query tools; the tools run in this browser over the published dataset, and every answer shows its evidence.",
  );
  await page
    .getByLabel("Question")
    .fill(
      `Which properties in Travis County within five miles of ${AGENT_PLACE} have roofs older than 15 years?`,
    );
  await page.getByRole("button", { name: "Ask" }).click();
  await page.locator(".bubble.agent").first().waitFor({ timeout: AGENT_TIMEOUT_MS });
  await show(page.locator(".evidence").first());
  await page.waitForTimeout(READ_MS);
  await show(page.locator(".bubble.agent").first());
  await caption(
    page,
    "Answer with source-backed evidence",
    "Matching properties, the roof-age basis and confidence, identifiers and the assumptions behind them.",
    LONG_READ_MS,
  );
  await caption(
    page,
    "Follow-up: long-open permits and contractors",
    "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
    READ_MS,
  );
  await page
    .getByLabel("Question")
    .fill(
      "Which properties near that area have open roofing permits that have been open for many years, and who is the listed contractor?",
    );
  await page.getByRole("button", { name: "Ask" }).click();
  await page.locator(".bubble.agent").nth(1).waitFor({ timeout: AGENT_TIMEOUT_MS });
  await show(page.locator(".turn").nth(1));
  await page.waitForTimeout(READ_MS);
  await show(page.locator(".bubble.agent").nth(1));
  await caption(
    page,
    "Answer to the follow-up",
    "The agent reuses the area, keeps permits still open five years or more that list a contractor, and states what the matches lack.",
    LONG_READ_MS,
  );

  await open(page, "mcp");
  await caption(
    page,
    "MCP-ready",
    "The same validated tools back the explorer, the agent, the stdio MCP server and the roofing CRM, with JSON Schemas for every input.",
  );
  await page.getByRole("button", { name: /find_open_roofing_permits/ }).click();
  await page.getByRole("button", { name: "Call tool" }).click();
  await page.locator(".data-table tbody tr").first().waitFor({ timeout: DATA_TIMEOUT_MS });
  await caption(
    page,
    "Calling a tool",
    "An MCP client receives the same rows, the SQL and the dataset CIDs.",
  );
  await show(page.getByRole("heading", { name: "Connect an MCP client" }));
  await caption(
    page,
    "Connect any MCP client",
    "npm run mcp starts the stdio server; it queries the latest publication over HTTP, or straight from public IPFS.",
    LONG_READ_MS,
  );

  const video = page.video();
  await context.close();
  await browser.close();
  const recorded = await video?.path();
  if (recorded) await rename(recorded, join(OUTPUT_DIR, "explorer-demo.webm"));
  console.log(await readdir(OUTPUT_DIR));
}

await record();
