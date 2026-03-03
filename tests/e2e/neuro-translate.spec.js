import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";

let server;
let baseUrl;

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/chaos") {
      const blocks = Number(url.searchParams.get("blocks") || "140");
      const html = renderChaosHtml(blocks);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("C1 incremental apply before final completion", async () => {
  const ext = await launchExtension();
  const page = await ext.context.newPage();
  await page.goto(`${baseUrl}/chaos?blocks=120`);

  const popup = await openPopup(ext.context, ext.extensionId);
  await setMockMode(popup, { enabled: true, forceError: false });
  await popup.locator("#btn-start").click();

  await expect
    .poll(async () => {
      const text = await page.locator("body").innerText();
      return text.includes("[RU]");
    })
    .toBe(true);

  await expect
    .poll(async () => {
      const counts = await readCounts(popup);
      return counts.done;
    })
    .toBeGreaterThan(0);

  await expect.poll(async () => readStage(popup), { timeout: 45_000 }).toBe("done");

  await ext.close();
});

test("C2 view switches and strict disabled rules", async () => {
  const ext = await launchExtension();
  const page = await ext.context.newPage();
  await page.goto(`${baseUrl}/chaos?blocks=80`);

  const popup = await openPopup(ext.context, ext.extensionId);
  await setMockMode(popup, { enabled: true, forceError: false });

  await expect(popup.locator("#btn-view-translation")).toBeDisabled();
  await expect(popup.locator("#btn-view-diff")).toBeDisabled();

  await popup.locator("#btn-start").click();
  await expect.poll(async () => readStage(popup), { timeout: 45_000 }).toBe("done");

  await expect(popup.locator("#btn-view-translation")).toBeEnabled();
  await expect(popup.locator("#btn-view-diff")).toBeEnabled();

  await popup.locator("#btn-view-translation").click();
  await expect(page.locator("body")).toContainText("[RU]");

  await popup.locator("#btn-view-original").click();
  await expect(page.locator("body")).toContainText("Alpha block 0");

  await popup.locator("#btn-view-diff").click();
  await expect(page.locator("body")).toContainText(" | ");

  await ext.close();
});

test("C3 hard cancel mid-flight keeps queue drained", async () => {
  const ext = await launchExtension();
  const page = await ext.context.newPage();
  await page.goto(`${baseUrl}/chaos?blocks=900`);

  const popup = await openPopup(ext.context, ext.extensionId);
  await setMockMode(popup, { enabled: true, forceError: false });
  await popup.locator("#btn-start").click();

  await expect
    .poll(async () => {
      const stage = await readStage(popup);
      return ["scanning", "context", "batching", "translating"].includes(stage);
    })
    .toBe(true);

  await popup.waitForTimeout(220);
  await popup.locator("#btn-cancel").click();

  await expect.poll(async () => readStage(popup), { timeout: 20_000 }).toBe("cancelled");

  const countsBefore = await readCounts(popup);
  await popup.waitForTimeout(1200);
  const countsAfter = await readCounts(popup);

  expect(countsAfter.done).toBe(countsBefore.done);
  expect(countsAfter.pending).toBe(0);

  await ext.close();
});

test("C4 API error is logged and reachable from error counter", async () => {
  const ext = await launchExtension();
  const page = await ext.context.newPage();
  await page.goto(`${baseUrl}/chaos?blocks=120`);

  const popup = await openPopup(ext.context, ext.extensionId);

  await popup.evaluate(async () => {
    const load = await chrome.runtime.sendMessage({ type: "ui.load_settings" });
    if (!load?.ok) {
      throw new Error(load?.error || "load settings failed");
    }
    const settings = load.result;
    settings.mockMode.enabled = true;
    settings.mockMode.forceError = true;
    const save = await chrome.runtime.sendMessage({ type: "ui.save_settings", settings });
    if (!save?.ok) {
      throw new Error(save?.error || "save settings failed");
    }
  });

  await popup.locator("#btn-start").click();
  await expect.poll(async () => readStage(popup), { timeout: 30_000 }).toBe("failed");

  await popup.locator("#error-pill").click();
  await expect(popup.locator('[data-panel="events"].active')).toBeVisible();
  await expect(popup.locator("#logs")).toContainText("pipeline_failed");

  await ext.close();
});

test("C5 simulated SW restart does not leave pipeline stuck running", async () => {
  test.setTimeout(120_000);
  const ext = await launchExtension();
  const page = await ext.context.newPage();
  await page.goto(`${baseUrl}/chaos?blocks=320`);

  const popup = await openPopup(ext.context, ext.extensionId);
  await setMockMode(popup, { enabled: true, forceError: false });
  await popup.locator("#btn-start").click();

  await expect
    .poll(async () => {
      const stage = await readStage(popup);
      return ["scanning", "context", "batching", "translating"].includes(stage);
    })
    .toBe(true);

  await popup.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({ type: "pipeline.resume" });
    if (!response?.ok) {
      throw new Error(response?.error || "resume call failed");
    }
  });

  await expect.poll(async () => readStage(popup), { timeout: 90_000 }).toBe("done");

  await ext.close();
});

test("C6 start is blocked without credentials in non-mock mode", async () => {
  const ext = await launchExtension();
  const page = await ext.context.newPage();
  await page.goto(`${baseUrl}/chaos?blocks=60`);

  const popup = await openPopup(ext.context, ext.extensionId);
  await popup.evaluate(async () => {
    const load = await chrome.runtime.sendMessage({ type: "ui.load_settings" });
    if (!load?.ok) {
      throw new Error(load?.error || "load settings failed");
    }
    const settings = load.result;
    settings.mockMode.enabled = false;
    settings.accessMode = "BYOK";
    settings.byokApiKey = "";
    settings.proxyToken = "";
    settings.proxyBaseUrl = "";
    const save = await chrome.runtime.sendMessage({ type: "ui.save_settings", settings });
    if (!save?.ok) {
      throw new Error(save?.error || "save settings failed");
    }
  });

  await popup.locator("#btn-start").click();

  await expect.poll(async () => readStage(popup), { timeout: 10_000 }).toBe("idle");
  await expect(popup.locator('[data-panel="status"]')).toContainText("Set BYOK API key or PROXY token in Settings");
  await expect(popup.locator("#btn-cancel")).toBeDisabled();

  await ext.close();
});

test("C7 profile editor uses one combobox input and switches profile to star", async () => {
  const ext = await launchExtension();
  const page = await ext.context.newPage();
  await page.goto(`${baseUrl}/chaos?blocks=20`);

  const popup = await openPopup(ext.context, ext.extensionId);
  await popup.locator('[data-tab="settings"]').click();
  await expect(popup.locator('[data-panel="settings"].active')).toBeVisible();

  const boolField = popup.locator('#profile-fields .profile-field[data-path="promptCaching.enabled"]');
  await expect(boolField).toBeVisible();
  await boolField.click();

  await expect(popup.locator("#field-editor-row")).toBeVisible();
  await expect(popup.locator("#field-editor-row input")).toHaveCount(1);

  const input = popup.locator("#field-editor-input");
  const current = (await input.inputValue()).trim();
  const next = current === "true" ? "false" : "true";
  await input.fill(next);
  await input.press("Enter");

  await expect(popup.locator("#profile-dirty-flag")).toHaveText("*");
  await expect(popup.locator("#profile-select")).toHaveValue("__custom__");

  await ext.close();
});

async function launchExtension() {
  const extensionPath = path.join(process.cwd(), "dist");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nt3-"));

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });

  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }

  const extensionId = new URL(worker.url()).host;

  return {
    context,
    extensionId,
    async close() {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

async function openPopup(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup/popup.html`);
  await expect(page.locator('[data-panel="status"].active')).toBeVisible();
  return page;
}

async function readStage(popup) {
  const value = await popup.locator(".summary-line").nth(1).locator("span").first().innerText();
  return value.trim();
}

async function readCounts(popup) {
  const summary = await popup.locator(".summary-line").first().locator("span").first().innerText();
  const [done, pending, failed] = summary
    .split("/")
    .map((part) => Number(part.trim()))
    .map((num) => (Number.isFinite(num) ? num : 0));
  return { done, pending, failed };
}

async function setMockMode(popup, { enabled, forceError }) {
  await popup.evaluate(async (payload) => {
    const load = await chrome.runtime.sendMessage({ type: "ui.load_settings" });
    if (!load?.ok) {
      throw new Error(load?.error || "load settings failed");
    }
    const settings = load.result;
    settings.mockMode.enabled = Boolean(payload.enabled);
    settings.mockMode.forceError = Boolean(payload.forceError);
    const save = await chrome.runtime.sendMessage({ type: "ui.save_settings", settings });
    if (!save?.ok) {
      throw new Error(save?.error || "save settings failed");
    }
  }, { enabled, forceError });
}

function renderChaosHtml(blocks) {
  const chunks = [];
  for (let i = 0; i < blocks; i += 1) {
    const hidden = i % 17 === 0 ? " style='display:none'" : "";
    chunks.push(`
      <section class="lvl-1" data-idx="${i}">
        <div class="lvl-2">
          <article class="lvl-3">
            <h3${hidden}>Hidden heading ${i}</h3>
            <p>Alpha block ${i}. This is text content with nested <span>inline unit ${i}</span> and trailing words.</p>
            <ul>
              <li>List item ${i} A</li>
              <li>List item ${i} B</li>
            </ul>
          </article>
        </div>
      </section>
    `);
  }

  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Chaos</title>
      </head>
      <body>
        <main id="root">${chunks.join("\n")}</main>
        <script>
          setTimeout(() => {
            const dyn = document.createElement("div");
            dyn.textContent = "Dynamic text node that appears later.";
            document.getElementById("root").appendChild(dyn);
          }, 80);
        </script>
      </body>
    </html>
  `;
}
