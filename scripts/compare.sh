#!/usr/bin/env bash
# compare.sh — Runs both before/after demos and prints a comparison table.
#
# Usage: bash scripts/compare.sh
#   or:  npm run compare  (from project root)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

RESULTS_DIR="$PROJECT_DIR/results"
BEFORE_CPUPROF_DIR="$RESULTS_DIR/before/cpuprofile"
AFTER_CPUPROF_DIR="$RESULTS_DIR/after/cpuprofile"
mkdir -p "$BEFORE_CPUPROF_DIR" "$AFTER_CPUPROF_DIR"

echo "============================================"
echo " Braintrust SDK Latency Regression Compare"
echo " BEFORE (v0.4.10) vs AFTER (v3.2.0)"
echo "============================================"
echo ""

# ---------------------------------------------------------------------------
# Helper: extract metrics from benchmark stdout
# ---------------------------------------------------------------------------
extract_metric() {
  local output="$1"
  local label="$2"
  echo "$output" | grep "$label" | head -1 | awk '{print $NF}'
}

# ---------------------------------------------------------------------------
# Run BEFORE benchmark
# ---------------------------------------------------------------------------
echo "[1/2] Running BEFORE benchmark (braintrust@0.4.10)..."
echo "      Expect ~2-5s (parallel chunk uploads via Promise.all)"
echo ""

BEFORE_OUTPUT=$(cd demo-before && node --cpu-prof --cpu-prof-dir="$BEFORE_CPUPROF_DIR" src/run-benchmark.mjs 2>&1) || true
echo "$BEFORE_OUTPUT"

BEFORE_WALL=$(extract_metric "$BEFORE_OUTPUT" "Wall time:")
BEFORE_UPLOADS=$(extract_metric "$BEFORE_OUTPUT" "Upload requests:")
BEFORE_LATENCY=$(extract_metric "$BEFORE_OUTPUT" "Upload latency:")
BEFORE_SDK=$(extract_metric "$BEFORE_OUTPUT" "SDK version:")

echo ""

# ---------------------------------------------------------------------------
# Run AFTER benchmark
# ---------------------------------------------------------------------------
echo "[2/2] Running AFTER benchmark (braintrust@3.2.0)..."
echo "      Expect ~15-20s (sequential while loop with await per chunk)"
echo ""

AFTER_OUTPUT=$(cd demo-after && node --cpu-prof --cpu-prof-dir="$AFTER_CPUPROF_DIR" src/run-benchmark.mjs 2>&1) || true
echo "$AFTER_OUTPUT"

AFTER_WALL=$(extract_metric "$AFTER_OUTPUT" "Wall time:")
AFTER_UPLOADS=$(extract_metric "$AFTER_OUTPUT" "Upload requests:")
AFTER_LATENCY=$(extract_metric "$AFTER_OUTPUT" "Upload latency:")
AFTER_SDK=$(extract_metric "$AFTER_OUTPUT" "SDK version:")

echo ""

# ---------------------------------------------------------------------------
# Comparison table
# ---------------------------------------------------------------------------
echo "============================================"
echo " Comparison Results"
echo "============================================"
echo ""
printf "%-22s  %-20s  %-20s\n" "Metric" "BEFORE (v${BEFORE_SDK:-0.4.10})" "AFTER (v${AFTER_SDK:-3.2.0})"
printf "%-22s  %-20s  %-20s\n" "----------------------" "--------------------" "--------------------"
printf "%-22s  %-20s  %-20s\n" "Wall time" "${BEFORE_WALL:-N/A}" "${AFTER_WALL:-N/A}"
printf "%-22s  %-20s  %-20s\n" "Upload requests" "${BEFORE_UPLOADS:-N/A}" "${AFTER_UPLOADS:-N/A}"
printf "%-22s  %-20s  %-20s\n" "Upload latency" "${BEFORE_LATENCY:-N/A}" "${AFTER_LATENCY:-N/A}"
echo ""

# ---------------------------------------------------------------------------
# CPU profile analysis
# ---------------------------------------------------------------------------
echo "============================================"
echo " CPU Profile Analysis"
echo "============================================"
echo ""

for prof in "$BEFORE_CPUPROF_DIR"/*.cpuprofile "$AFTER_CPUPROF_DIR"/*.cpuprofile; do
  if [ -f "$prof" ]; then
    node src/analyze-profile.mjs "$prof"
    echo ""
  fi
done

# ---------------------------------------------------------------------------
# Output files summary
# ---------------------------------------------------------------------------
echo "============================================"
echo " Output Files"
echo "============================================"
echo ""
echo "BEFORE results:"
ls -la "$RESULTS_DIR/before/"*.json 2>/dev/null || echo "  (none)"
echo ""
echo "AFTER results:"
ls -la "$RESULTS_DIR/after/"*.json 2>/dev/null || echo "  (none)"
echo ""
echo "CPU profiles:"
ls -la "$BEFORE_CPUPROF_DIR"/*.cpuprofile 2>/dev/null || echo "  (none in before/)"
ls -la "$AFTER_CPUPROF_DIR"/*.cpuprofile 2>/dev/null || echo "  (none in after/)"
echo ""
echo "To view CPU profiles, upload to https://speedscope.app"
echo ""
echo "BEFORE: upload requests should overlap (parallel Promise.all)"
echo "AFTER:  sequential idle gaps between chunk awaits"
