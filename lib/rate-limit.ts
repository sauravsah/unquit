import "server-only";
import { queryOne, type Db } from "@/lib/db/core";

/**
 * Counts one hit on a fixed-window bucket (widget_rate_limit_hit, migration
 * 0002) and says whether it is still within `max`. Fails open, logging, when
 * the counter itself is unavailable: a database blip must not lock everyone out.
 */
export async function underRateLimit(db: Db, bucket: string, windowSeconds: number, max: number, label = "rate-limit"): Promise<boolean> {
  try {
    const row = await queryOne<{ ok: boolean }>(db, "select widget_rate_limit_hit($1::text, $2::integer, $3::integer) as ok", [
      bucket,
      windowSeconds,
      max,
    ]);
    return row?.ok !== false;
  } catch (error) {
    console.error(`[${label}] rate limiter unavailable`, error instanceof Error ? error.message : error);
    return true;
  }
}
