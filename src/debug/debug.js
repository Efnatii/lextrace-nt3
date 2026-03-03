import { EVENT_CATEGORY, MESSAGE } from "../shared/constants.js";
import { callRuntime } from "../shared/runtime-api.js";

const app = document.getElementById("debug-app");
const filters = {
  category: "",
  onlyErrors: false
};

render();
await refreshLogs();
setInterval(() => {
  refreshLogs().catch(() => {});
}, 1800);

function render() {
  app.innerHTML = `
    <div class="toolbar">
      <select id="category-filter" title="Категория">
        <option value="">all</option>
        ${Object.values(EVENT_CATEGORY)
          .map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
          .join("")}
      </select>
      <button id="errors-only" title="Только ошибки">!</button>
      <button id="download-log" title="Скачать лог">↓</button>
      <button id="copy-log" title="Копировать лог">⎘</button>
    </div>
    <div id="log-list"></div>
  `;

  app.querySelector("#category-filter")?.addEventListener("change", async (event) => {
    filters.category = event.target.value;
    await refreshLogs();
  });

  app.querySelector("#errors-only")?.addEventListener("click", async () => {
    filters.onlyErrors = !filters.onlyErrors;
    await refreshLogs();
  });

  app.querySelector("#download-log")?.addEventListener("click", downloadLog);
  app.querySelector("#copy-log")?.addEventListener("click", copyLog);
}

async function refreshLogs() {
  const data = await callRuntime(MESSAGE.LOG_QUERY, {
    filters: {
      ...filters,
      limit: 1500
    }
  });

  app.querySelector("#category-filter").value = filters.category;
  app.querySelector("#errors-only").style.background = filters.onlyErrors ? "#111" : "#fff";
  app.querySelector("#errors-only").style.color = filters.onlyErrors ? "#fff" : "#111";

  app.querySelector("#log-list").innerHTML = data.items
    .map((row) => {
      const summary = `${row.ts} | ${row.level} | ${row.category} | ${row.name}`;
      const payload = JSON.stringify(
        {
          pageSessionId: row.pageSessionId,
          tabId: row.tabId,
          batchId: row.batchId,
          blockId: row.blockId,
          data: row.data,
          error: row.error
        },
        null,
        2
      );
      return `<details><summary>${escapeHtml(summary)}</summary><pre>${escapeHtml(payload)}</pre></details>`;
    })
    .join("");
}

async function downloadLog() {
  const text = await callRuntime(MESSAGE.LOG_EXPORT, { filters });
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: `neuro-translate-debug-log-${Date.now()}.json`,
    saveAs: true
  });
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyLog() {
  const text = await callRuntime(MESSAGE.LOG_EXPORT, { filters });
  await navigator.clipboard.writeText(text);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
