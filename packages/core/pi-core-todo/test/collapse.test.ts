import { describe, expect, test } from "bun:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TodoOverlay } from "../src/overlay.ts";
import { clearActiveRenderSession, commitState, setActiveRenderSession } from "../src/store.ts";
import type { Task, TaskState } from "../src/types.ts";
import { renderWidget } from "../src/view.ts";

const theme = {
	fg: (_color: string, text: string) => `\u001b[37m${text}\u001b[39m`,
	bg: (_color: string, text: string) => `\u001b[48;2;48;48;48m${text}\u001b[49m`,
	strikethrough: (text: string) => `\u001b[9m${text}\u001b[29m`,
} as unknown as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
const task = (id: number, status: Task["status"], subject = `Task ${id}`, parentId?: number): Task => ({
	id,
	subject,
	status,
	...(parentId === undefined ? {} : { parentId }),
});
const fixture: TaskState = {
	tasks: [
		task(1, "pending", "Build the widget"),
		task(2, "completed", "Read the source", 1),
		task(3, "in_progress", "Add collapse", 1),
	],
	nextId: 4,
};

describe("widget collapse rendering", () => {
	test("collapsed renders one summary line with counts and the active task", () => {
		const result = renderWidget(fixture, new Set(), theme, 80, 40, { collapsed: true, clickable: true });
		expect(result.lines).toHaveLength(1);
		expect(result.displayedIds).toEqual([]);
		const text = plain(result.lines);
		expect(text).toContain("▸");
		expect(text).toContain("Todos (1/3)");
		expect(text).toContain("Add collapse");
		expect(text).toContain("click or /todos");
	});

	test("collapsed drops the click hint when the terminal cannot report clicks", () => {
		const text = plain(renderWidget(fixture, new Set(), theme, 80, 40, { collapsed: true }).lines);
		expect(text).toContain("Todos (1/3)");
		expect(text).not.toContain("click");
	});

	test("expanded header carries a disclosure chevron and collapse hint", () => {
		const result = renderWidget(fixture, new Set(), theme, 80, 40, { clickable: true });
		const text = plain(result.lines);
		expect(text).toContain("▾");
		expect(result.lines).toHaveLength(4);
		expect(text.split("\n")[0]).toContain("click to collapse");
		expect(plain(renderWidget(fixture, new Set(), theme, 80, 40).lines)).not.toContain("click to collapse");
	});

	test("collapsed stays width-bounded and renders nothing without a budget", () => {
		for (const width of [1, 8, 16, 24, 40, 80]) {
			const lines = renderWidget(fixture, new Set(), theme, width, 40, { collapsed: true, clickable: true }).lines;
			expect(lines).toHaveLength(1);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(renderWidget(fixture, new Set(), theme, 80, 3, { collapsed: true }).lines).toEqual([]);
		expect(renderWidget({ tasks: [], nextId: 1 }, new Set(), theme, 80, 40, { collapsed: true }).lines).toEqual([]);
	});
});

describe("widget click toggling", () => {
	const SESSION = "collapse-test-session";

	function harness(mode: "regular" | "fullscreen" = "fullscreen") {
		clearActiveRenderSession();
		setActiveRenderSession(SESSION);
		commitState(SESSION, structuredClone(fixture));
		let factory: ((tui: TUI, theme: Theme) => { render(width: number): string[]; handleMouse?: unknown }) | undefined;
		const ui = {
			setWidget: (_key: string, content: typeof factory) => {
				factory = content;
			},
			theme,
		} as unknown as ExtensionUIContext;
		const tui = {
			mode,
			terminal: { rows: 40 },
			requestRender: () => {},
		} as unknown as TUI;
		const overlay = new TodoOverlay();
		overlay.setUICtx(ui);
		overlay.update();
		const component = factory!(tui, theme) as unknown as {
			render(width: number): string[];
			handleMouse(event: Record<string, unknown>): { handled?: boolean } | undefined;
		};
		return { overlay, tui, component, ui };
	}

	const click = (extra: Record<string, unknown> = {}) => ({
		type: "click",
		button: "left",
		x: 2,
		y: 0,
		screenX: 2,
		screenY: 10,
		width: 80,
		height: 8,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	});

	test("left click collapses, second click expands", () => {
		const { overlay, component } = harness();
		expect(plain(component.render(80))).not.toContain("▸");
		expect(component.handleMouse(click())).toEqual({ handled: true });
		expect(overlay.isCollapsed()).toBe(true);
		expect(component.render(80)).toHaveLength(1);
		expect(plain(component.render(80))).toContain("▸");
		component.handleMouse(click());
		expect(overlay.isCollapsed()).toBe(false);
		expect(plain(component.render(80))).toContain("▾");
	});

	test("non-click and non-left events do not toggle", () => {
		const { overlay, component } = harness();
		expect(component.handleMouse(click({ type: "press" }))).toBeUndefined();
		expect(component.handleMouse(click({ type: "release" }))).toBeUndefined();
		expect(component.handleMouse(click({ button: "right" }))).toBeUndefined();
		expect(component.handleMouse(click({ type: "wheel", button: "none" }))).toBeUndefined();
		expect(overlay.isCollapsed()).toBe(false);
	});

	test("regular mode has no mouse path but the command path still collapses", () => {
		const { overlay, component } = harness("regular");
		expect(plain(component.render(80))).not.toContain("click to collapse");
		expect(component.handleMouse(click())).toBeUndefined();
		expect(overlay.isCollapsed()).toBe(false);
		overlay.setCollapsed(true);
		expect(component.render(80)).toHaveLength(1);
		expect(plain(component.render(80))).not.toContain("click or /todos");
	});

	test("an explicit expand brings back rows hidden after the previous turn", () => {
		const { overlay, component } = harness();
		expect(plain(component.render(80))).toContain("Read the source");
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(plain(component.render(80))).not.toContain("Read the source");
		overlay.setCollapsed(true);
		overlay.setCollapsed(false);
		expect(plain(component.render(80))).toContain("Read the source");
	});
});
