import type BaseStrategy from "./BaseStrategy";
import { HttpError } from "../utils/HttpError";

/**
 * Merge user overrides onto the strategy defaults and check them against the
 * param schema. Throws HttpError(400) on the first invalid value.
 */
export function resolveStrategyParams(
  strategy: BaseStrategy,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged = { ...strategy.getDefaultParams(), ...overrides };

  for (const def of strategy.getParamSchema()) {
    const val = merged[def.key];
    if (val === undefined) continue;

    if (def.type === "number" && typeof val === "number") {
      if (def.min !== undefined && val < def.min) {
        throw new HttpError(400, `Parameter '${def.key}' must be >= ${def.min}`);
      }
      if (def.max !== undefined && val > def.max) {
        throw new HttpError(400, `Parameter '${def.key}' must be <= ${def.max}`);
      }
    }

    if (def.type === "select" && def.options) {
      const validValues = def.options.map((o) => o.value);
      if (!validValues.includes(String(val))) {
        throw new HttpError(400, `Parameter '${def.key}' must be one of: ${validValues.join(", ")}`);
      }
    }
  }

  return merged;
}
