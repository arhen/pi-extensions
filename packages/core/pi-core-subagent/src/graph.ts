/** Graph Protocol §2/§6: dependency resolution, wave notation, edge payloads,
 *  and the wave-frontier scheduler. Pure logic — no pi imports, easily tested. */
import type { RunMode } from "./types.ts";

/**
 * Resolve dependency edges (Graph Protocol §2). Returns one id list per task,
 * in input order. Chain mode is just `needs: [previous]`, so both modes run
 * through the same wave scheduler.
 *
 * Throws on unknown ids, self-edges, and cycles — a bad graph must fail before
 * any child is spawned, never halfway through a run.
 */
export function resolveNeeds(inputs: { id?: string; needs?: string[] }[], mode: RunMode): string[][] {
	const ids = inputs.map((input, index) => input.id ?? `task_${index + 1}`);
	const known = new Set(ids);
	const edges = inputs.map((input, index) => {
		if (mode === "chain") return index === 0 ? [] : [ids[index - 1] as string];
		const needs = input.needs ?? [];
		for (const need of needs) {
			if (!known.has(need)) throw new Error(`Task ${ids[index]} needs unknown task id: ${need}`);
			if (need === ids[index]) throw new Error(`Task ${ids[index]} cannot need itself.`);
		}
		return [...new Set(needs)];
	});
	// Kahn's algorithm: if any task never becomes ready, the remainder is a cycle.
	const done = new Set<string>();
	let progress = true;
	while (progress) {
		progress = false;
		for (const [index, id] of ids.entries()) {
			if (done.has(id)) continue;
			if ((edges[index] as string[]).every((need) => done.has(need))) {
				done.add(id);
				progress = true;
			}
		}
	}
	if (done.size !== ids.length) {
		throw new Error(`Cycle in subagent needs: ${ids.filter((id) => !done.has(id)).join(", ")}`);
	}
	return edges;
}

/**
 * Graph Protocol §2 notation: `wave1[api ∥ db] → gate → wave2[doc]`.
 *
 * Tolerates half-streamed args: a need pointing at an id that has not arrived yet
 * keeps its task out of the ready set, so the layout settles as the model types.
 * Returns "" when there are no edges — flat fan-out gets no graph vocabulary.
 */
export function waveNotation(tasks: { id?: string; needs?: string[] }[]): string {
	if (!tasks.some((t) => t.needs?.length)) return "";
	const ids = tasks.map((t, i) => t.id ?? `task_${i + 1}`);
	const settled = new Set<string>();
	let remaining = tasks.map((t, i) => ({ id: ids[i] as string, needs: t.needs ?? [] }));
	const waves: string[][] = [];
	while (remaining.length > 0) {
		const ready = remaining.filter((t) => t.needs.every((n) => settled.has(n)));
		if (ready.length === 0) break; // cycle, or an upstream id not typed yet
		waves.push(ready.map((t) => t.id));
		for (const t of ready) settled.add(t.id);
		remaining = remaining.filter((t) => !settled.has(t.id));
	}
	if (remaining.length > 0) waves.push(remaining.map((t) => t.id)); // show them rather than drop them
	if (waves.length < 2) return "";
	const full = waves.map((w, i) => `wave${i + 1}[${w.join(" ∥ ")}]`).join(" → gate → ");
	// Long graphs: keep the shape, drop the names.
	return full.length <= 100 ? full : waves.map((w, i) => `wave${i + 1}[${w.length}]`).join(" → gate → ");
}

/**
 * Graph Protocol §6: the edge carries the upstream output, not just ordering.
 * Upstream results are prepended verbatim; `{previous}` stays supported so old
 * chain prompts keep working (it expands to the first need's output).
 */
export function applyUpstream(task: string, needs: string[], outputs: Map<string, string>): string {
	if (needs.length === 0) {
		return task.includes("{previous}")
			? `${task.replace(/\{previous\}/g, () => "")}\n\n(Note: {previous} was empty — no prior step output existed yet.)`
			: task;
	}
	const first = outputs.get(needs[0] as string) ?? "";
	const body = task.replace(/\{previous\}/g, () => first); // replacer fn: no $ corruption
	const blocks = needs.map((need) => `## Output of ${need}\n${outputs.get(need) ?? "(no output)"}`);
	return `${blocks.join("\n\n")}\n\n---\n\n${body}`;
}

export async function mapWithConcurrency<T>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			await fn(items[index] as T, index);
		}
	});
	await Promise.all(workers);
}

export interface SchedulerTask {
	id: string;
	needs?: string[];
}

export interface SkippedTask {
	id: string;
	needs: string[];
}

/** Wave-frontier scheduler (Graph Protocol §2 execution). Pure control flow:
 *  the caller owns the settled/output bookkeeping and supplies the per-task
 *  runner, so the loop is testable without spawning children. Tasks whose
 *  needs never produced an output (upstream failed/aborted/canceled) are
 *  skipped, not run. */
export async function runWaveScheduler<T extends SchedulerTask>(
	tasks: T[],
	concurrency: number,
	outputs: Map<string, string>,
	settled: Set<string>,
	run: (task: T, index: number) => Promise<void>,
): Promise<{ skipped: SkippedTask[] }> {
	let remaining = [...tasks];
	const skipped: SkippedTask[] = [];
	while (remaining.length > 0) {
		const ready = remaining.filter((t) => (t.needs ?? []).every((need) => settled.has(need)));
		// resolveNeeds() rejects cycles up front, so an empty frontier here means every
		// remaining task is downstream of one that never settled (canceled mid-run).
		if (ready.length === 0) break;
		await mapWithConcurrency(ready, concurrency, async (task) => {
			const index = tasks.indexOf(task);
			const needs = task.needs ?? [];
			// An upstream failure means this task's input never existed. Running it anyway
			// burns a full child session on a prompt with a hole in it.
			const broken = needs.filter((need) => !outputs.has(need));
			if (broken.length > 0) skipped.push({ id: task.id, needs: broken });
			else await run(task, index);
		});
		for (const task of ready) settled.add(task.id);
		remaining = remaining.filter((t) => !settled.has(t.id));
	}
	return { skipped };
}
