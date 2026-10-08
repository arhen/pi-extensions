import type { Task } from "./types.ts";

export interface TaskRow {
	task: Task;
	depth: number;
}

export function childLetter(index: number): string {
	let label = "";
	for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
		label = String.fromCharCode(97 + ((n - 1) % 26)) + label;
	}
	return label;
}

export class TaskTree {
	readonly byId = new Map<number, Task>();
	readonly parent = new Map<number, number>();
	readonly children = new Map<number, Task[]>();
	readonly preorder: TaskRow[] = [];
	private readonly letters = new Map<number, string>();
	private readonly lastSiblings = new Set<number>();

	constructor(readonly tasks: readonly Task[]) {
		for (const task of tasks) this.byId.set(task.id, task);
		for (const task of tasks) {
			if (task.parentId !== undefined && task.parentId !== task.id && this.byId.has(task.parentId)) {
				this.parent.set(task.id, task.parentId);
			}
		}
		const visited = new Set<number>();
		for (const task of tasks) {
			const path = new Set<number>();
			let id: number | undefined = task.id;
			while (id !== undefined && !visited.has(id)) {
				path.add(id);
				const next = this.parent.get(id);
				if (next !== undefined && path.has(next)) {
					this.parent.delete(id);
					break;
				}
				id = next;
			}
			for (const member of path) visited.add(member);
		}
		const roots: Task[] = [];
		for (const task of tasks) {
			const parent = this.parent.get(task.id);
			if (parent === undefined) roots.push(task);
			else {
				const siblings = this.children.get(parent) ?? [];
				this.letters.set(task.id, childLetter(siblings.length));
				siblings.push(task);
				this.children.set(parent, siblings);
			}
		}
		for (const siblings of [roots, ...this.children.values()]) {
			const last = siblings.filter((task) => task.status !== "deleted").at(-1);
			if (last) this.lastSiblings.add(last.id);
		}
		const stack = roots
			.slice()
			.reverse()
			.map((task) => ({ task, depth: 0 }));
		while (stack.length) {
			const row = stack.pop()!;
			this.preorder.push(row);
			const children = this.children.get(row.task.id) ?? [];
			for (let i = children.length - 1; i >= 0; i--) {
				stack.push({ task: children[i]!, depth: row.depth + 1 });
			}
		}
	}

	ancestors(id: number): number[] {
		const result: number[] = [];
		let parent = this.parent.get(id);
		while (parent !== undefined) {
			result.push(parent);
			parent = this.parent.get(parent);
		}
		return result.reverse();
	}

	label(id: number, maxParts = Infinity): string {
		const path = this.ancestors(id);
		path.push(id);
		const root = path[0] ?? id;
		const children = path.slice(1).map((child) => this.letters.get(child) ?? "?");
		if (children.length > maxParts) return `#${root}.….${children.slice(-maxParts).join(".")}`;
		return `#${root}${children.length ? `.${children.join(".")}` : ""}`;
	}

	isLastSibling(id: number): boolean {
		return this.lastSiblings.has(id);
	}

	progress(id: number): { done: number; total: number } {
		const children = (this.children.get(id) ?? []).filter((task) => task.status !== "deleted");
		return { done: children.filter((task) => task.status === "completed").length, total: children.length };
	}

	rows(collapsed: ReadonlySet<number> = new Set(), visible?: ReadonlySet<number>): TaskRow[] {
		const rows: TaskRow[] = [];
		let collapsedDepth: number | undefined;
		for (const row of this.preorder) {
			if (collapsedDepth !== undefined) {
				if (row.depth > collapsedDepth) continue;
				collapsedDepth = undefined;
			}
			if (row.task.status === "deleted" || (visible && !visible.has(row.task.id))) continue;
			rows.push(row);
			if (collapsed.has(row.task.id)) collapsedDepth = row.depth;
		}
		return rows;
	}
}

export function prioritizeRows(tree: TaskTree, visible: ReadonlySet<number>, limit: number): TaskRow[] {
	if (limit <= 0) return [];
	const selected = new Set<number>();
	const add = (id: number): void => {
		if (selected.size < limit && tree.byId.get(id)?.status !== "deleted") selected.add(id);
	};
	const addContext = (id: number): void => {
		if (selected.size >= limit) return;
		const ancestors = tree.ancestors(id);
		if (ancestors.length) add(ancestors[0]!);
		for (let i = ancestors.length - 1; i >= 0 && selected.size < limit; i--) add(ancestors[i]!);
	};
	const active = tree.tasks.filter((task) => visible.has(task.id) && task.status === "in_progress");
	for (const task of active) {
		if (selected.size >= limit) break;
		add(task.id);
	}
	for (const task of active) addContext(task.id);
	for (const task of active) {
		if (selected.size >= limit) break;
		for (const ancestor of tree.ancestors(task.id).reverse()) {
			if (selected.size >= limit) break;
			for (const child of tree.children.get(ancestor) ?? []) {
				if (selected.size >= limit) break;
				if (visible.has(child.id)) add(child.id);
			}
		}
	}
	for (const status of ["pending", "completed"] as const) {
		for (const row of tree.preorder) {
			if (selected.size >= limit) break;
			if (!visible.has(row.task.id) || row.task.status !== status) continue;
			add(row.task.id);
			addContext(row.task.id);
		}
	}
	return tree.preorder.filter((row) => selected.has(row.task.id));
}
