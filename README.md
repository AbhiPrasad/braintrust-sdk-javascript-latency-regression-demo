# Braintrust SDK JavaScript Latency Regression Demo

Reproduction and analysis of a significant latency regression in the [Braintrust JavaScript SDK](https://github.com/braintrustdata/braintrust-sdk-javascript) between versions `0.4.10` and `3.2.0`.

Based on the original work by [@CodingCanuck](https://github.com/CodingCanuck) in [braintrustdata/braintrust-sdk-javascript#1394](https://github.com/braintrustdata/braintrust-sdk-javascript/issues/1394), with the original regression report and benchmark at [CodingCanuck/braintrust-sdk `BUG_REPORT.md`](https://github.com/CodingCanuck/braintrust-sdk/blob/latency-regression-in-1.0/js/repro/latency-regression/BUG_REPORT.md).

## The Problem

The SDK introduced sequential chunk uploads in a memory optimization commit, replacing parallel `Promise.all` uploads with a `while` loop that `await`s each chunk one at a time. Combined with a small default chunk size (25 rows), this caused:

| Metric | v0.4.10 (Baseline) | v3.2.0 (Regressed) | Impact |
|--------|-------------------|-------------------|--------|
| Wall time | 2.17s | 17.89s | **8.2x slower** |
| Upload requests | 6 | 50 | 8.3x more |
| Upload latency | 1,735ms | 17,412ms | 10x higher |
| Overlapping requests | 10 | 0 | **Zero parallelism** |

## Project Structure

```
├── demo-before/          # Benchmark using braintrust@0.4.10 (baseline)
├── demo-after/           # Benchmark using braintrust@3.2.0 (regressed)
├── shared/
│   └── http-metrics.mjs  # Fetch instrumentation for HTTP metrics
├── scripts/
│   └── compare.sh        # Runs both benchmarks and compares results
├── src/
│   └── analyze-profile.mjs  # V8 CPU profile analyzer
└── results/
    ├── before/           # Baseline benchmark results (JSON)
    ├── after/            # Regressed benchmark results (JSON)
    └── analysis.md       # Detailed findings and root cause analysis
```

## Setup

```bash
cp .env.example .env
# Add your BRAINTRUST_API_KEY to .env

npm install
cd demo-before && npm install
cd ../demo-after && npm install
```

## Usage

Run the full comparison:

```bash
npm run compare
# or
bash scripts/compare.sh
```

Run individual benchmarks:

```bash
cd demo-before && npm run benchmark
cd demo-after && npm run benchmark
```

Run with CPU profiling:

```bash
cd demo-before && npm run benchmark:prof
cd demo-after && npm run benchmark:prof
```

Test with a larger chunk size (demo-after only):

```bash
cd demo-after && BRAINTRUST_LOG_FLUSH_CHUNK_SIZE=10000000 npm run benchmark
```

Analyze CPU profiles:

```bash
node src/analyze-profile.mjs results/cpuprofile/CPU.*.cpuprofile
```

You can also view `.cpuprofile` files on [speedscope.app](https://speedscope.app) for detailed timeline analysis.

## Root Causes

### 1. Sequential Chunk Uploads (Primary)

The regressed code uploads chunks one at a time in a `while` loop with `await`, instead of uploading in parallel via `Promise.all`. This serializes all network I/O, turning parallel round-trips into sequential ones.

### 2. Small Default Chunk Size (Secondary)

The default chunk size of 25 rows produces many small HTTP requests (50 requests for ~360 rows), each incurring connection overhead. Increasing the chunk size to 100 reduces request count from 50 to 20.

## Results

See [`results/analysis.md`](results/analysis.md) for the full analysis, including before/after metrics with the proposed fix.
