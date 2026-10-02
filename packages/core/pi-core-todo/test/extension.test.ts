import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import extension from "../src/index.ts";
import type { TaskDetails } from "../src/types.ts";
import { TodoParamsSchema } from "../src/types.ts";

type TodoTool = ToolDefinition<typeof TodoParamsSchema, TaskDetails, { label?: string }>;
type RenderContext = Parameters<NonNullable<TodoTool["renderCall"]>>[2];
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text } as unknown as Theme;

function registeredTool(): TodoTool {
	let tool: TodoTool | undefined;
	extension({ registerTool: (value: TodoTool) => { tool = value; }, registerCommand: () => {}, on: () => () => {} } as unknown as ExtensionAPI);
	return tool!;
}

function context(): RenderContext {
	return { state: {}, invalidate: () => {} } as RenderContext;
}

const details: TaskDetails = {
	action: "update",
	params: { id: 3 },
	tasks: [
		{ id: 1, subject: "Parent", status: "pending" },
		{ id: 2, parentId: 1, subject: "First child", status: "completed" },
		{ id: 3, parentId: 1, subject: "Second child", status: "in_progress" },
	],
	nextId: 4,
};

describe("tool heading identifiers", () => {
	test("hierarchical label appears only in heading, never todo rows", () => {
		const tool = registeredTool();
		const ctx = context();
		const call = tool.renderCall!({ action: "update", id: 3 }, theme, ctx);
		const result = tool.renderResult!({ content: [{ type: "text", text: "Updated #1.b (id: 3)" }], details }, { expanded: false, isPartial: false }, theme, ctx);
		expect(call.render(80).join("\n")).toBe("todo → #1.b");
		expect(result.render(80).join("\n")).toContain("Second child");
		expect(result.render(80).join("\n")).not.toContain("#");
		expect(result.render(80).join("\n")).not.toContain("id: 3");
	});
	test("snapshot label survives later unrelated state changes", () => {
		const tool = registeredTool();
		const ctx = context();
		tool.renderResult!({ content: [], details }, { expanded: false, isPartial: false }, theme, ctx);
		expect(tool.renderCall!({ action: "get", id: 3 }, theme, ctx).render(80)[0]).toBe("todo › #1.b");
	});
	test("create heading receives its snapshot label after result", () => {
		const tool = registeredTool();
		const ctx = context();
		const call = tool.renderCall!({ action: "create", subject: "Second child", parentId: 1 }, theme, ctx);
		tool.renderResult!({ content: [], details: { ...details, action: "create" } }, { expanded: false, isPartial: false }, theme, ctx);
		expect(call.render(80)[0]).toBe("todo + #1.b Second child");
	});
	test("partial/error results do not overwrite identifier context", () => {
		const tool = registeredTool();
		const ctx = context();
		ctx.state.label = "#1.b";
		tool.renderResult!({ content: [{ type: "text", text: "Failure" }], details: { ...details, error: "Failure" } }, { expanded: false, isPartial: false }, theme, ctx);
		expect(ctx.state.label).toBe("#1.b");
	});
	test("long subjects and labels stay single-line", () => {
		const tool = registeredTool();
		const ctx = context();
		ctx.state.label = "#1." + "a.".repeat(100);
		const call = tool.renderCall!({ action: "create", subject: "中文🌳\n".repeat(100) }, theme, ctx);
		for (const width of [1, 8, 20, 80]) {
			const lines = call.render(width);
			expect(lines.length).toBe(1);
			expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
		}
	});
	test("renderer invalidation is deferred and occurs once per new label", async () => {
		const tool = registeredTool();
		const ctx = context();
		let invalidations = 0;
		ctx.invalidate = () => { invalidations++; };
		const result = { content: [], details };
		tool.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
		expect(invalidations).toBe(0);
		await Promise.resolve();
		expect(invalidations).toBe(1);
		tool.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx);
		await Promise.resolve();
		expect(invalidations).toBe(1);
	});
	test("real Pi tool component never duplicates result rows on invalidation", async () => {
		const base = import.meta.resolve("@earendil-works/pi-coding-agent");
		const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", base).href);
		const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", base).href);
		initTheme("dark", false);
		const ui = { requestRender: () => {}, terminal: { columns: 80, rows: 32 } };
		const component = new ToolExecutionComponent("todo", "regression", { action: "update", id: 3 }, { showImages: false }, registeredTool(), ui, process.cwd());
		component.updateResult({ content: [{ type: "text", text: "Updated" }], details, isError: false });
		const text = () => component.render(80).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
		expect(text().match(/Second child/g)?.length).toBe(1);
		await Promise.resolve();
		expect(text().match(/Second child/g)?.length).toBe(1);
		expect(text()).toContain("todo → #1.b");
	});
	test("shared state mutations execute sequentially", () => {
		expect(registeredTool().executionMode).toBe("sequential");
	});
});
