# Braintrust SDK Latency Regression Analysis

**Issue:** [#1394](https://github.com/braintrustdata/braintrust-sdk/issues/1394)
**Date:** 2026-03-02
**Workload:** 40 examples × 8 spans each, 128-byte payloads, maxConcurrency=4

## Results

### Before any fix (sequential `while` loop, chunk size 25)

| Metric | BEFORE (v0.4.10) | AFTER (v3.2.0) | Change |
|---|---|---|---|
| **Wall time** | 2.17s | 17.89s | **8.2x slower** |
| **Upload requests** | 6 | 50 | 8.3x more |
| **Upload wall span** | 1,735ms | 17,412ms | 10x longer |
| **Overlapping request pairs** | 10 | 0 | No parallelism |
| **Upload throughput** | 178 KB/s | 20 KB/s | **8.9x lower** |
| **CPU idle %** | 89.0% | 97.1% | More time waiting on network |

### After fix (parallel chunks with concurrency limit of 10, chunk size 100)

| Metric | BEFORE (v0.4.10) | FIXED (v3.2.0+patch) | Change |
|---|---|---|---|
| **Wall time** | 1.66s | 6.82s | **4.1x slower** (was 8.2x) |
| **Upload requests** | 6 | 20 | 3.3x more (was 8.3x) |
| **Upload wall span** | ~1,400ms | 6,291ms | 4.5x longer (was 10x) |
| **Total upload latency (sum)** | 3,557ms | 6,234ms | 1.8x (was 4x) |
| **Avg request latency** | 593ms | 312ms | 1.9x lower |
| **Payload sent** | 316 KB | 325 KB | ~same |

### Fix impact summary

| | Unfixed v3.2.0 | Fixed v3.2.0 | Improvement |
|---|---|---|---|
| Wall time | 17.89s | 6.82s | **2.6x faster** |
| Upload requests | 50 | 20 | **2.5x fewer** |
| Total upload latency | 17,276ms | 6,234ms | **2.8x less** |

## Root Cause

The regression has two components:

### 1. Sequential chunk uploads (primary cause — fixed)

The `flushOnce()` method in `HTTPBackgroundLogger` (`js/src/logger.ts`) used a `while` loop that `await`ed each chunk upload sequentially. The v0.4.10 SDK uploaded chunks in parallel via `Promise.all`.

**Before (regressed):**
```
req 1:  |==655ms==|
req 2:             |==407ms==|
req 3:                        |==360ms==|  ...  (50 sequential requests)
        0ms                                      17,412ms
```

**After fix:**
Chunks within each flush call now run in parallel (up to 10 at a time).

### 2. Small default chunk size (secondary cause — fixed)

The default `flushChunkSize` was **25 rows**, producing 50 small HTTP requests for ~360 rows of data. Increasing it to **100** reduced the request count to **20** and nearly halved total server-side latency (17.3s → 6.2s cumulative).

### Remaining gap

The fixed v3.2.0 (6.8s) is still ~4x slower than v0.4.10 (1.7s). This is because:

- v3.2.0 triggers **20 separate flush calls** during evaluation (roughly 2 per concurrency batch), each producing a single chunk. These flushes are sequential by nature — they happen at different points during the evaluation.
- v0.4.10 aggregates more aggressively, producing only **6 total requests** across fewer flush points.
- With chunk size 100 and <100 items per flush, each flush now has only 1 chunk, so the within-flush parallelism doesn't kick in. The bottleneck is now 20 sequential round-trips × ~300ms avg = ~6s.

Fully closing the gap would require reducing how often the evaluator triggers flushes (a deeper architectural change).

## The Fix

**File:** `js/src/logger.ts`, class `HTTPBackgroundLogger`

### Change 1: Increase default chunk size (line 2650)

```typescript
// BEFORE
public flushChunkSize: number = 25;

// AFTER
public flushChunkSize: number = 100;
```

### Change 2: Parallel chunk uploads with concurrency limit (flushOnce method)

```typescript
// BEFORE (regressed — sequential)
let index = 0;
while (index < wrappedItems.length) {
  const chunk = wrappedItems.slice(index, index + chunkSize);
  await this.flushWrappedItemsChunk(chunk, batchSize);
  index += chunk.length;
}

// AFTER (fixed — parallel with concurrency limit)
const chunks: LazyValue<BackgroundLogEvent>[][] = [];
for (let index = 0; index < wrappedItems.length; index += chunkSize) {
  chunks.push(wrappedItems.slice(index, index + chunkSize));
}

const maxConcurrent = 10;
for (let i = 0; i < chunks.length; i += maxConcurrent) {
  await Promise.all(
    chunks
      .slice(i, i + maxConcurrent)
      .map((chunk) => this.flushWrappedItemsChunk(chunk, batchSize)),
  );
}
```

## Speedscope Viewing Guide

CPU profile files for viewing in [speedscope.app](https://speedscope.app):

- **BEFORE (v0.4.10):** `results/before/cpuprofile/CPU.20260302.131232.99231.0.001.cpuprofile`
- **AFTER fixed (v3.2.0+patch):** `results/after/cpuprofile/CPU.20260302.131238.99282.0.001.cpuprofile`

When viewing in the "left heavy" or "timeline" view:
- **BEFORE:** Look for overlapping `fetch` calls — upload requests stack on top of each other
- **AFTER (fixed):** Each flush batch sends 1 chunk (due to larger chunk size), so requests appear sequential across flush calls, but each individual request carries more data
