/**
 * Fetch monkey-patching for HTTP request metrics.
 *
 * Adapted from CodingCanuck's http-metrics.mjs:
 * https://github.com/CodingCanuck/braintrust-sdk/blob/latency-regression-in-1.0/js/repro/latency-regression/http-metrics.mjs
 *
 * Overrides globalThis.fetch to record per-endpoint request metrics including
 * count, latency, payload size, status codes, and a timeline of individual
 * request start/end times for visualization.
 */

/**
 * Installs fetch instrumentation and returns the mutable metrics map.
 *
 * @returns {Record<string, {count:number,totalMs:number,maxMs:number,bytes:number,statuses:Record<string,number>,timeline:{start:number,end:number}[]}>}
 */
export function installFetchMetrics() {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const endpoints = {};

  globalThis.fetch = async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    const url =
      typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url;

    const key = `${method} ${endpointPath(url)}`;
    const start = Date.now();
    let status = "FETCH_ERROR";

    try {
      const response = await originalFetch(input, init);
      status = String(response.status);
      return response;
    } finally {
      const e = endpoints[key] ?? {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        bytes: 0,
        statuses: {},
        timeline: [],
      };

      const end = Date.now();
      const elapsedMs = end - start;
      e.count += 1;
      e.totalMs += elapsedMs;
      e.maxMs = Math.max(e.maxMs, elapsedMs);
      e.bytes += requestBytes(init?.body);
      e.statuses[status] = (e.statuses[status] ?? 0) + 1;
      e.timeline.push({ start, end });
      endpoints[key] = e;
    }
  };

  return endpoints;
}

/**
 * Summarizes only upload-related traffic from endpoint metrics.
 *
 * @param {Record<string, {count:number,totalMs:number}>} endpoints
 * @returns {{requestCount:number,totalLatencyMs:number}}
 */
export function summarizeUploads(endpoints) {
  let requestCount = 0;
  let totalLatencyMs = 0;

  for (const [key, metric] of Object.entries(endpoints)) {
    if (key.includes("/logs") || key.includes("/logs3")) {
      requestCount += metric.count;
      totalLatencyMs += metric.totalMs;
    }
  }

  return {
    requestCount,
    totalLatencyMs: Math.round(totalLatencyMs),
  };
}

/**
 * Formats endpoint metrics as a human-readable table.
 *
 * @param {Record<string, object>} endpoints
 */
export function formatMetricsTable(endpoints) {
  const rows = Object.entries(endpoints)
    .sort(([, a], [, b]) => b.totalMs - a.totalMs)
    .map(([key, m]) => ({
      endpoint: key,
      count: m.count,
      totalMs: Math.round(m.totalMs),
      maxMs: Math.round(m.maxMs),
      avgMs: Math.round(m.totalMs / m.count),
      bytes: m.bytes,
      statuses: JSON.stringify(m.statuses),
    }));

  console.log("\n--- HTTP Endpoint Metrics ---");
  console.table(rows);
}

/** Extracts pathname from a URL for stable endpoint labeling. */
function endpointPath(urlLike) {
  try {
    return new URL(String(urlLike)).pathname;
  } catch {
    return String(urlLike);
  }
}

/** Best-effort request payload size estimate. */
function requestBytes(body) {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (Buffer.isBuffer(body)) return body.length;
  if (body instanceof URLSearchParams) {
    return Buffer.byteLength(body.toString(), "utf8");
  }
  return 0;
}
