/**
 * Sleep for `ms` milliseconds. Resolves on the next event-loop tick after
 * the timer fires. Used by both polling loops in `sandbox.ts` and `pool.ts`
 * to keep their cadence consistent and avoid duplicating the helper.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
