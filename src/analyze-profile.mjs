#!/usr/bin/env node

/**
 * CLI tool to summarize .cpuprofile files.
 *
 * Reads a V8 CPU profile JSON and prints the top functions by self-time
 * (sample count), useful for quick CLI triage without Chrome DevTools.
 *
 * Usage: node src/analyze-profile.mjs <path-to.cpuprofile>
 */

import fs from "node:fs";
import path from "node:path";

const TOP_N = 30;

function analyze(profilePath) {
  const raw = fs.readFileSync(profilePath, "utf8");
  const profile = JSON.parse(raw);

  const { nodes, samples, startTime, endTime } = profile;

  if (!nodes || !samples) {
    console.error("Invalid .cpuprofile format: missing nodes or samples");
    process.exit(1);
  }

  const durationUs = endTime - startTime;
  const durationMs = Math.round(durationUs / 1000);
  const totalSamples = samples.length;

  // Build node lookup
  const nodeMap = new Map();
  for (const node of nodes) {
    nodeMap.set(node.id, node);
  }

  // Count self-time samples per node
  const selfCounts = new Map();
  for (const sampleId of samples) {
    selfCounts.set(sampleId, (selfCounts.get(sampleId) ?? 0) + 1);
  }

  // Build sorted list
  const entries = [];
  for (const [nodeId, count] of selfCounts) {
    const node = nodeMap.get(nodeId);
    if (!node) continue;

    const fn = node.callFrame;
    const name = fn.functionName || "(anonymous)";
    const file = fn.url ? path.basename(fn.url) : "(native)";
    const line = fn.lineNumber ?? 0;

    entries.push({
      name,
      location: `${file}:${line}`,
      selfSamples: count,
      selfPct: ((count / totalSamples) * 100).toFixed(1),
    });
  }

  entries.sort((a, b) => b.selfSamples - a.selfSamples);

  // Print report
  console.log(`\n=== CPU Profile Analysis ===`);
  console.log(`File:            ${path.basename(profilePath)}`);
  console.log(`Duration:        ${durationMs}ms`);
  console.log(`Total samples:   ${totalSamples}`);
  console.log(`Unique nodes:    ${selfCounts.size}`);
  console.log(`\nTop ${TOP_N} functions by self-time:\n`);

  console.log(
    `${"#".padStart(3)}  ${"Self%".padStart(6)}  ${"Samples".padStart(8)}  ${"Function".padEnd(40)}  Location`
  );
  console.log("-".repeat(90));

  for (let i = 0; i < Math.min(TOP_N, entries.length); i++) {
    const e = entries[i];
    console.log(
      `${String(i + 1).padStart(3)}  ${e.selfPct.padStart(6)}%  ${String(e.selfSamples).padStart(8)}  ${e.name.padEnd(40).slice(0, 40)}  ${e.location}`
    );
  }

  // Highlight flush-related functions
  const flushEntries = entries.filter(
    (e) =>
      e.name.includes("flush") ||
      e.name.includes("Flush") ||
      e.name.includes("submitLogs") ||
      e.name.includes("chunk")
  );

  if (flushEntries.length > 0) {
    console.log(`\n--- Flush-related functions ---`);
    for (const e of flushEntries) {
      console.log(
        `  ${e.selfPct}% (${e.selfSamples} samples)  ${e.name}  ${e.location}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log("Usage: node src/analyze-profile.mjs <path-to.cpuprofile>");
  console.log("\nAnalyzes a V8 CPU profile and prints top functions by self-time.");
  process.exit(0);
}

for (const arg of args) {
  if (!fs.existsSync(arg)) {
    console.error(`File not found: ${arg}`);
    continue;
  }
  analyze(arg);
}
