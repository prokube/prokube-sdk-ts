/**
 * Wall-clock timing collection for the live E2E suite.
 *
 * Mirrors the per-operation table printed by pk-sandbox's
 * `tests/e2e/bench_sandbox.py` (`_print_single`), for a single round: the
 * suite exercises each lifecycle operation once, so there is no median or
 * range column.
 */

interface Timing {
	label: string;
	seconds: number;
	failed: boolean;
}

const timings: Timing[] = [];

/** Run `operation`, recording its wall-clock duration under `label`. */
export async function timed<T>(label: string, operation: () => Promise<T>): Promise<T> {
	const start = performance.now();
	try {
		const result = await operation();
		timings.push({ label, seconds: (performance.now() - start) / 1000, failed: false });
		return result;
	} catch (error) {
		timings.push({ label, seconds: (performance.now() - start) / 1000, failed: true });
		throw error;
	}
}

/** Print the collected timings as a table; no-op when nothing was recorded. */
export function printTimingReport(title: string): void {
	if (timings.length === 0) return;

	const labelWidth = Math.max(...timings.map((entry) => entry.label.length), "Operation".length);
	const rule = "=".repeat(labelWidth + 16);
	const lines = [
		rule,
		`  ${title}`,
		rule,
		`  ${"Operation".padEnd(labelWidth)} ${"Duration".padStart(10)}`,
		`  ${"-".repeat(labelWidth)} ${"-".repeat(10)}`,
	];
	for (const { label, seconds, failed } of timings) {
		const duration = `${seconds.toFixed(3)}s${failed ? " !" : ""}`;
		lines.push(`  ${label.padEnd(labelWidth)} ${duration.padStart(10)}`);
	}
	lines.push(rule);
	console.info(`\n${lines.join("\n")}\n`);
}
