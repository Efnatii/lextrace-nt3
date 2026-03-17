import path from "node:path";

import { ensureDir, paths, writeJson } from "./lib/common.mjs";
import { closeAiHarnessSession, prepareEdgeAiArtifacts, startAiHarnessSession } from "./lib/edge-ai-harness.mjs";
import {
  BASELINE_SCENARIO_ORDER,
  createBaselineAiReport,
  createBaselineAiState,
  runBaselineAiSuite
} from "./lib/edge-ai-baseline-suite.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.listScenarios) {
    console.log(BASELINE_SCENARIO_ORDER.join("\n"));
    return;
  }

  let session = null;
  const state = createBaselineAiState();
  const report = createBaselineAiReport(null, state);

  try {
    await prepareEdgeAiArtifacts({
      runPreflight: !options.skipPreflight && !options.reuseArtifacts,
      reuseArtifacts: options.reuseArtifacts
    });
    session = await startAiHarnessSession();
    report.environment.extensionId = session.extensionId;

    await runBaselineAiSuite(session, {
      report,
      state,
      scenarioNames: options.scenarioNames
    });
  } finally {
    report.finishedAt = report.finishedAt ?? new Date().toISOString();
    await ensureDir(path.dirname(options.reportPath));
    await writeJson(options.reportPath, report);
    await closeAiHarnessSession(session);
  }

  const failedScenarios = report.scenarios.filter((scenario) => scenario.status === "failed");
  if (failedScenarios.length > 0) {
    throw new Error(`Edge AI test suite finished with ${failedScenarios.length} failed scenario(s). Report: ${options.reportPath}`);
  }

  console.log(`Edge AI test suite passed. Scenarios: ${report.scenarios.length}. Report: ${options.reportPath}`);
}

function parseArgs(argv) {
  const options = {
    grep: null,
    reportPath: path.join(paths.artifacts, "test-results", "edge-ai-report.json"),
    scenarioNames: null,
    skipPreflight: false,
    reuseArtifacts: false,
    listScenarios: false
  };

  for (const argument of argv) {
    if (argument === "--skip-preflight") {
      options.skipPreflight = true;
      continue;
    }

    if (argument === "--reuse-artifacts") {
      options.reuseArtifacts = true;
      continue;
    }

    if (argument === "--list-scenarios") {
      options.listScenarios = true;
      continue;
    }

    if (argument.startsWith("--grep=")) {
      options.grep = argument.slice("--grep=".length);
      continue;
    }

    if (argument.startsWith("--scenario=") || argument.startsWith("--scenarios=")) {
      const rawValue = argument.slice(argument.indexOf("=") + 1);
      options.scenarioNames = rawValue
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      continue;
    }

    if (argument.startsWith("--report=")) {
      options.reportPath = path.resolve(argument.slice("--report=".length));
      continue;
    }

    throw new Error(`Unsupported argument: ${argument}`);
  }

  if (options.grep) {
    options.scenarioNames = BASELINE_SCENARIO_ORDER.filter((name) => name.toLowerCase().includes(options.grep.toLowerCase()));
  }

  return options;
}

await main();
