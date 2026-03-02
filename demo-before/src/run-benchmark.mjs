#!/usr/bin/env node

/**
 * BEFORE (pre-regression) benchmark — braintrust@0.4.10
 *
 * This version uses parallel chunk uploads via Promise.all, resulting in
 * significantly faster flush times compared to the post-regression version.
 *
 * Adapted from CodingCanuck's run-one.mjs:
 * https://github.com/CodingCanuck/braintrust-sdk/blob/latency-regression-in-1.0/js/repro/latency-regression/run-one.mjs
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

// Load .env from project root (two levels up from this file's directory)
dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { installFetchMetrics, summarizeUploads, formatMetricsTable } from "../../shared/http-metrics.mjs";

// ---------------------------------------------------------------------------
// Workload configuration (all overridable via env vars)
// ---------------------------------------------------------------------------
const WORKLOAD = {
  examples: parseInt(process.env.BENCHMARK_EXAMPLES ?? "40", 10),
  logsPerExample: parseInt(process.env.BENCHMARK_LOGS_PER_EXAMPLE ?? "8", 10),
  payloadBytes: parseInt(process.env.BENCHMARK_PAYLOAD_BYTES ?? "128", 10),
  maxConcurrency: parseInt(process.env.BENCHMARK_MAX_CONCURRENCY ?? "4", 10),
  summarizeScores: false,
};

const EVAL_NAME = process.env.BENCHMARK_EVAL_NAME ?? "sdk-latency-regression-repro";
const LABEL = "BEFORE (pre-regression)";
const RESULTS_DIR = path.resolve(import.meta.dirname, "../../results/before");

// ---------------------------------------------------------------------------
// Detect SDK version
// ---------------------------------------------------------------------------
function getSdkVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("braintrust/package.json");
    return pkg.version;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Synthetic evaluator
// ---------------------------------------------------------------------------
function syntheticEvaluator() {
  const payload = "x".repeat(WORKLOAD.payloadBytes);
  const data = Array.from({ length: WORKLOAD.examples }, (_, i) => ({
    input: { i },
    expected: i,
    metadata: { i },
  }));

  return {
    data,
    task: async (input, hooks) => {
      for (let j = 0; j < WORKLOAD.logsPerExample; j++) {
        const span = hooks.span.startSpan({
          name: "synthetic-log",
          event: {
            input: { i: input.i, j },
            metadata: { j, payload },
          },
        });
        span.end();
      }
      return input.i;
    },
    scores: [({ output, expected }) => Number(output === expected)],
    summarizeScores: WORKLOAD.summarizeScores,
    maxConcurrency: WORKLOAD.maxConcurrency,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const sdkVersion = getSdkVersion();
  console.log(`\n[${ LABEL }]`);
  console.log(`braintrust SDK version: ${sdkVersion}`);
  console.log("Workload:", JSON.stringify(WORKLOAD, null, 2));

  // Install fetch instrumentation before importing braintrust
  const endpoints = installFetchMetrics();

  // Dynamic import so fetch patching is in place first
  const { Eval, flush } = await import("braintrust");

  performance.mark("eval-start");
  const start = Date.now();
  let error = null;

  try {
    await Eval(EVAL_NAME, syntheticEvaluator(), {});
    performance.mark("eval-done");
    performance.mark("flush-start");
    if (typeof flush === "function") {
      await flush();
    }
    performance.mark("flush-done");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const wallTimeSec = Number(((Date.now() - start) / 1000).toFixed(3));

  // Measure phases for CPU profile annotations
  try {
    performance.measure("eval-phase", "eval-start", "eval-done");
    performance.measure("flush-phase", "flush-start", "flush-done");
    performance.measure("total", "eval-start", "flush-done");
  } catch {
    // marks may not exist if an error occurred
  }

  const uploads = summarizeUploads(endpoints);
  const totalRequests = Object.values(endpoints).reduce((n, e) => n + e.count, 0);

  // Build output
  const result = {
    timestamp: new Date().toISOString(),
    label: LABEL,
    sdkVersion,
    run: { wallTimeSec },
    workload: WORKLOAD,
    rpc: {
      totalRequests,
      uploads,
      endpoints,
    },
    error,
  };

  // Write results to file
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(RESULTS_DIR, `benchmark-${ts}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n", "utf8");

  // Print summary
  console.log(`\n=== ${LABEL} — Benchmark Results ===`);
  console.log(`SDK version:       ${sdkVersion}`);
  console.log(`Wall time:         ${wallTimeSec}s`);
  console.log(`Total requests:    ${totalRequests}`);
  console.log(`Upload requests:   ${uploads.requestCount}`);
  console.log(`Upload latency:    ${uploads.totalLatencyMs}ms`);
  console.log(`Results written:   ${outFile}`);

  formatMetricsTable(endpoints);

  if (error) {
    console.error(`\nError: ${error}`);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
