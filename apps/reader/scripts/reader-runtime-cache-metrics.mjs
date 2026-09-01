export const INTERACTIVE_POLL_INTERVAL_MS = 25;
export const P95_MEASUREMENT_TOLERANCE_MS = INTERACTIVE_POLL_INTERVAL_MS;

// 可交互状态通过 waitFor 的同一轮询周期观测；小样本 nearest-rank P95
// 实际上接近最大值，因此允许一次观测周期的调度误差，但中位数仍保持严格门槛。

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function withMeasurementTolerance(value, toleranceMs) {
  return value === null ? null : value + toleranceMs;
}

export function buildPerformanceThresholds(
  epubColdValues,
  markdownColdValues,
  toleranceMs = P95_MEASUREMENT_TOLERANCE_MS,
) {
  return {
    epub: {
      hitReturnInteractiveMedianMs: median(epubColdValues),
      hitReturnInteractiveP95Ms: withMeasurementTolerance(
        percentile(epubColdValues, 0.95),
        toleranceMs,
      ),
    },
    markdown: {
      hitReturnInteractiveMedianMs: median(markdownColdValues),
      hitReturnInteractiveP95Ms: withMeasurementTolerance(
        percentile(markdownColdValues, 0.95),
        toleranceMs,
      ),
    },
    measurementToleranceMs: toleranceMs,
  };
}
