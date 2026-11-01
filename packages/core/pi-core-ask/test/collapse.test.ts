import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireComponent } from "../src/ui.ts";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
const ALT_S = "\x1bs";

test("alt+s folds the box to one row, keeps the answer state, and Enter only unfolds", () => {
	const renders: boolean[] = [];
	const tui = { requestRender: (force = false) => renders.push(force) } as any;
	let result: unknown;
	const box = new QuestionnaireComponent(
		[
			{
				question: "Which fruit do you want for the long-running demo?",
				header: "Fruit",
				options: [
					{ label: "Apple", description: "A very long description ".repeat(20) },
					{ label: "Banana", description: "Sweet" },
				],
			},
			{
				question: "Size?",
				header: "Size",
				options: [
					{ label: "S", description: "small" },
					{ label: "L", description: "large" },
				],
			},
		],
		tui,
		theme,
		(r) => (result = r),
	);

	const open = box.render(120);
	expect(open.length).toBeGreaterThan(12);
	expect(open.join("\n")).toContain("alt+s collapse");

	box.handleInput("\x1b[B");
	box.handleInput(ALT_S);
	expect(renders.at(-1)).toBe(true);
	const folded = box.render(120);
	expect(folded).toHaveLength(3);
	expect(folded[1]).toContain("▸ Questions (1/2)");
	expect(folded[1]).toContain("[Fruit]");
	expect(folded[1]).toContain("enter/alt+s expand");
	for (const w of [20, 60, 120]) for (const l of box.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);

	// Folded: arrows and option keys do nothing, Enter unfolds without answering.
	box.handleInput("\x1b[A");
	box.handleInput("\r");
	expect(result).toBeUndefined();
	const back = box.render(120).join("\n");
	expect(back).toContain("▾ Questions (1/2)");
	expect(back).toMatch(/→ Banana/);

	// Header click toggles; clicks elsewhere do not.
	expect(box.handleMouse({ type: "click", button: "left", y: 5 } as any)).toBeUndefined();
	expect(box.handleMouse({ type: "click", button: "left", y: 1 } as any)).toEqual({ handled: true });
	expect(box.render(120)).toHaveLength(3);

	// Esc still cancels while folded.
	box.handleInput("\x1b");
	expect(result).toEqual({ answers: [], cancelled: true });
});
