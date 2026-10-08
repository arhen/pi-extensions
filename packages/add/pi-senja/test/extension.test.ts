import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModeEngine } from "../../pi-add-mode/src/engine.ts";
import type { ModeStore } from "../../pi-add-mode/src/store.ts";
import { type Mode, WORKING_MESSAGE_EVENT } from "../../pi-add-mode/src/types.ts";
import { assistantEntry, createHarness, plain } from "./harness.ts";

let now: number;
let intervals: Map<ReturnType<typeof setInterval>, () => void>;
let clock: ReturnType<typeof spyOn<typeof Date, "now">>;
let startInterval: ReturnType<typeof spyOn<typeof globalThis, "setInterval">>;
let stopInterval: ReturnType<typeof spyOn<typeof globalThis, "clearInterval">>;
let output: ReturnType<typeof spyOn<typeof process.stdout, "write">>;
let ttyDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
	now = 1_000;
	intervals = new Map();
	clock = spyOn(Date, "now").mockImplementation(() => now);
	startInterval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
		const id = {} as ReturnType<typeof setInterval>;
		intervals.set(id, callback);
		return id;
	}) as typeof setInterval);
	stopInterval = spyOn(globalThis, "clearInterval").mockImplementation((id) => {
		intervals.delete(id as ReturnType<typeof setInterval>);
	});
	output = spyOn(process.stdout, "write").mockImplementation(() => true);
	ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
	clock.mockRestore();
	startInterval.mockRestore();
	stopInterval.mockRestore();
	output.mockRestore();
	if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor);
	else Reflect.deleteProperty(process.stdout, "isTTY");
});

function tick(ms: number) {
	now += ms;
	for (const callback of intervals.values()) callback();
}

function footerText(h: ReturnType<typeof createHarness>, width = 400): string[] {
	return h.footer!.render(width).map(plain);
}

describe("startup and toggle", () => {
	test("factory only registers; terminal startup installs Senja header/footer/theme", async () => {
		const h = createHarness();
		expect([...h.commands.keys()]).toEqual(["senja"]);
		expect(h.ui.setTheme).not.toHaveBeenCalled();
		expect(startInterval).not.toHaveBeenCalled();
		await h.emit("session_start", { reason: "startup" });
		expect(h.ui.setTheme).toHaveBeenCalledWith("senja");
		expect(h.footer).toBeDefined();
		expect(h.header).toBeDefined();
		expect(h.subscribers.size).toBe(1);
		expect(output).not.toHaveBeenCalled();
		expect(h.ui.notify).not.toHaveBeenCalled();
	});

	test("clear screen only for initial TUI startup on a real TTY; preserve scrollback", async () => {
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		expect(output).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith("\x1b[2J\x1b[H");
		for (const reason of ["reload", "new", "resume", "fork"]) await h.emit("session_start", { reason });
		expect(output).toHaveBeenCalledTimes(1);
	});

	test("toggle restores components without changing theme; repeated starts honor off state", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await h.toggle();
		expect(h.footer).toBeUndefined();
		expect(h.header).toBeUndefined();
		expect(h.subscribers.size).toBe(0);
		expect(h.ui.notify).toHaveBeenLastCalledWith("Default UI restored", "info");
		expect(h.ui.setTheme).toHaveBeenCalledTimes(1);
		await h.emit("session_start", { reason: "new" });
		expect(h.footer).toBeUndefined();
		expect(h.header).toBeUndefined();
		await h.toggle();
		expect(h.footer).toBeDefined();
		expect(h.header).toBeDefined();
		expect(h.subscribers.size).toBe(1);
		expect(h.ui.notify).toHaveBeenLastCalledWith("Senja enabled", "info");
		expect(h.ui.setTheme).toHaveBeenCalledTimes(2);
	});

	test("theme failure warns but preserves the UI", async () => {
		const h = createHarness();
		h.setThemeResult({ success: false, error: "missing theme" });
		await h.emit("session_start", { reason: "startup" });
		expect(h.ui.notify).toHaveBeenCalledWith("Senja theme: missing theme", "warning");
		expect(h.footer).toBeDefined();
	});

	for (const mode of ["print", "json", "rpc"] as const) {
		test(`${mode} never installs terminal UI, switches theme, clears screen, or starts a timer`, async () => {
			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			const h = createHarness(mode);
			await h.emit("session_start", { reason: "startup" });
			await h.emit("agent_start");
			tick(2_000);
			await h.emit("agent_end");
			await h.toggle();
			await h.emit("session_shutdown");
			expect(h.ui.setFooter).not.toHaveBeenCalled();
			expect(h.ui.setHeader).not.toHaveBeenCalled();
			expect(h.ui.setTheme).not.toHaveBeenCalled();
			expect(h.ui.setWorkingMessage).not.toHaveBeenCalled();
			expect(h.ui.setWorkingVisible).not.toHaveBeenCalled();
			expect(startInterval).not.toHaveBeenCalled();
			expect(output).not.toHaveBeenCalled();
			if (mode === "rpc") {
				expect(h.ui.notify).toHaveBeenCalledTimes(1);
				expect(h.ui.notify).toHaveBeenCalledWith("Senja requires terminal UI mode", "info");
			} else expect(h.ui.notify).not.toHaveBeenCalled();
			h.ctx.mode = "tui";
			h.ctx.hasUI = true;
			await h.emit("session_start", { reason: "new" });
			expect(h.footer).toBeDefined();
		});
	}
});

describe("state and cleanup", () => {
	for (const activation of ["before", "after"] as const) {
		test(`mode label and color survive timer updates when activated ${activation} Senja startup`, async () => {
			const h = createHarness();
			const engine = new ModeEngine(h.api as unknown as ConstructorParameters<typeof ModeEngine>[0]);
			const ctx = h.ctx as unknown as Parameters<ModeEngine["activate"]>[1];
			const modes: Mode[] = [
				{ name: "review", enabled: true, color: "warning", tools: "default", leaderOverride: false },
				{ name: "build", enabled: true, tools: "default", leaderOverride: false },
			];
			engine.setStore({ get: (name: string) => modes.find((mode) => mode.name === name) } as ModeStore);
			if (activation === "before") await engine.activate("review", ctx);
			await h.emit("session_start", { reason: "startup" });
			if (activation === "after") await engine.activate("review", ctx);

			await h.emit("agent_start");
			const coloredLabel = h.ui.theme.fg("warning", "review is working...");
			expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith(`${coloredLabel} 0s`);
			tick(65_000);
			expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith(`${coloredLabel} 1m 5s`);
			await h.emit("agent_end");
			expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("Worked for 1m 5s");

			await engine.activate("build", ctx);
			await h.emit("agent_start");
			expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("build is working... 0s");
			await h.emit("agent_end");

			await engine.activate(undefined, ctx);
			await h.emit("agent_start");
			expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("Working… 0s");
			await h.emit("agent_end");

			await engine.activate("review", ctx);
			engine.reset(ctx);
			await h.emit("session_start", { reason: "new" });
			await h.emit("agent_start");
			expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("Working… 0s");
			await h.emit("session_shutdown");
		});
	}

	test("live duration, completion, next prompt, and session reset", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		await h.emit("agent_start");
		expect(startInterval).toHaveBeenCalledWith(expect.any(Function), 250);
		expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("Working… 0s");
		tick(65_000);
		expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("Working… 1m 5s");
		expect(footerText(h)[1]).toContain("working 1m 5s");
		await h.emit("agent_end");
		expect(intervals.size).toBe(0);
		expect(footerText(h)[1]).toContain("worked for 1m 5s");
		expect(h.ui.setWorkingVisible).toHaveBeenCalledWith(true);
		expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("Worked for 1m 5s");
		expect(h.ui.notify).toHaveBeenLastCalledWith("Worked for 1m 5s", "info");
		await h.emit("agent_start");
		expect(footerText(h)[1]).toContain("working 0s");
		expect(footerText(h).join(" ")).not.toContain("worked for");
		await h.emit("session_start", { reason: "new" });
		expect(intervals.size).toBe(0);
		expect(footerText(h)).toHaveLength(1);
		await h.emit("agent_end");
		expect(footerText(h)).toHaveLength(1);
	});

	test("mode updates refresh on the next tick, ignore invalid payloads, and clear empty labels", async () => {
		const h = createHarness();
		await h.emit("agent_start");
		h.events.emit(WORKING_MESSAGE_EVENT, "review is working...");
		tick(1_000);
		expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("review is working... 1s");
		h.events.emit(WORKING_MESSAGE_EVENT, { invalid: true });
		tick(1_000);
		expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("review is working... 2s");
		h.events.emit(WORKING_MESSAGE_EVENT, "");
		tick(1_000);
		expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("Working… 3s");
		await h.emit("session_shutdown");
	});

	test("hour-long durations; timer replacement and teardown-safe UI calls", async () => {
		const h = createHarness();
		await h.emit("agent_start");
		await h.emit("agent_start");
		expect(intervals.size).toBe(1);
		tick(3_661_000);
		expect(h.ui.setWorkingMessage).toHaveBeenLastCalledWith("Working… 1h 1m 1s");
		h.ui.setWorkingMessage.mockImplementation(() => {
			throw new Error("UI disposed");
		});
		tick(250);
		await expect(h.emit("agent_end")).resolves.toBeUndefined();
		expect(intervals.size).toBe(0);
	});

	test("branch subscriptions replace/dispose idempotently, including stale host disposal", async () => {
		const h = createHarness();
		expect(h.bus.listenerCount(WORKING_MESSAGE_EVENT)).toBe(1);
		await h.emit("session_start", { reason: "startup" });
		const first = h.footer!;
		h.recreateFooter();
		expect(h.subscribers.size).toBe(1);
		first.dispose?.();
		await h.emit("thinking_level_select");
		const count = h.render.mock.calls.length;
		h.branchChanged();
		expect(h.render).toHaveBeenCalledTimes(count + 1);
		await h.emit("session_start", { reason: "reload" });
		expect(h.subscribers.size).toBe(1);
		await h.emit("agent_start");
		expect(intervals.size).toBe(1);
		await h.emit("session_shutdown");
		await h.emit("session_shutdown");
		expect(intervals.size).toBe(0);
		expect(h.subscribers.size).toBe(0);
		expect(h.bus.listenerCount(WORKING_MESSAGE_EVENT)).toBe(0);
		const afterShutdown = h.render.mock.calls.length;
		h.branchChanged();
		await h.emit("model_select");
		h.footer?.dispose?.();
		expect(h.render).toHaveBeenCalledTimes(afterShutdown);
	});

	test("enable state, render handles, and timers belong to each extension instance", async () => {
		const a = createHarness();
		const b = createHarness();
		await a.emit("session_start", { reason: "startup" });
		await a.toggle();
		await b.emit("session_start", { reason: "startup" });
		expect(b.footer).toBeDefined();
		await a.emit("agent_start");
		tick(1_000);
		await b.emit("agent_start");
		expect(intervals.size).toBe(2);
		expect(footerText(b)[1]).toContain("working 0s");
		const before = b.render.mock.calls.length;
		await a.emit("model_select");
		expect(b.render).toHaveBeenCalledTimes(before);
		await a.emit("session_shutdown");
		expect(intervals.size).toBe(1);
		expect(b.subscribers.size).toBe(1);
		await b.emit("session_shutdown");
		expect(intervals.size).toBe(0);
	});
});

describe("header and footer rendering", () => {
	test("preserves grouped header copy and identity", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		const lines = h.header!.render(140).map(plain);
		expect(lines[0]).toBe(`pi v${VERSION}`);
		expect(lines[1]).toBe("");
		expect(lines.join("\n")).toContain("  control   esc interrupt · ctrl+c clear");
		expect(lines.join("\n")).toContain("  models    ctrl+p next · shift+ctrl+p prev");
		expect(lines.join("\n")).toContain("  view      ctrl+o tools · ctrl+t thinking · ctrl+g editor");
		expect(lines.join("\n")).toContain("  input     / commands · ! bash · !! bash·nc");
		expect(lines.at(-1)).toBe("  Pi can explain its own features and look up its docs.");
	});

	test("all lines fit narrow/wide widths with ANSI, Unicode, long metadata, and statuses", async () => {
		const h = createHarness();
		h.setCwd("/project/项目/👩‍💻/e\u0301/".repeat(20));
		h.setSessionName("会话👩‍💻".repeat(40));
		h.setBranch("分支".repeat(50));
		h.setUsage({ tokens: 50_000, contextWindow: 500_000, percent: 10 });
		h.setEntries([assistantEntry(123_000, 50_000, 70_000, 8_000, 8.5)]);
		h.statuses.set("long", "\x1b[32m✓ 项目状态 👩‍💻\x1b[0m".repeat(40));
		await h.emit("session_start", { reason: "startup" });
		await h.emit("agent_start");
		for (const width of [0, 1, 2, 3, 5, 8, 11, 12, 13, 20, 40, 60, 80, 120, 240]) {
			for (const component of [h.header!, h.footer!]) {
				for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				component.invalidate();
			}
		}
		await h.emit("session_shutdown");
	});

	test("location, provider, effort, aggregate usage, latest cache, context, subscription, sorted statuses", async () => {
		const h = createHarness();
		h.setCwd(`${process.env.HOME}/project`);
		h.setLevel("max");
		h.ctx.modelRegistry.isUsingOAuth = () => true;
		h.setUsage({ tokens: 50_000, contextWindow: 500_000, percent: 10 });
		h.setEntries([assistantEntry(1_000, 100, 2_000, 1_000, 0.01), assistantEntry(1_000, 200, 8_000, 1_000, 0.025)]);
		h.statuses.set("z", "last\nline\tstatus");
		h.statuses.set("a", "\x1b[32mfirst\x1b[0m\x1b[2J\x07\x1b]0;bad title\x07");
		h.statuses.set("empty", "\n\t  ");
		await h.emit("session_start", { reason: "startup" });
		const lines = footerText(h);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("~/project branch main session test-session");
		expect(lines[0]).toEndWith("anthropic ▪ claude-test ▪ max");
		expect(lines[1]).toContain("in ↑2.0k | out ↓300 | cache hit 80.0% | cost $0.035 (sub)");
		expect(lines[1]).toEndWith("[██░░░░░░░░░░░░░░] 10.0% ▪ 50k/500k");
		expect(lines[2]).toBe("first | last line status");
		expect(h.footer!.render(400)[2]).not.toContain("\x1b[2J");
		expect(h.footer!.render(400)[2]).toContain("\x1b[32mfirst");
		expect(h.roles).toContainEqual(["thinkingMax", "max"]);
		const before = h.render.mock.calls.length;
		await h.emit("model_select");
		await h.emit("thinking_level_select");
		expect(h.render).toHaveBeenCalledTimes(before + 2);
	});

	test("provider and all effort roles, cache thresholds, context pressure", async () => {
		const h = createHarness();
		await h.emit("session_start", { reason: "startup" });
		const providers = {
			anthropic: "accent",
			"openai-codex": "success",
			google: "warning",
			"amazon-bedrock": "thinkingHigh",
			"github-copilot": "mdLink",
			deepseek: "thinkingLow",
			xai: "error",
			groq: "error",
			"opencode-go": "accent",
			unknown: "muted",
		} as const;
		for (const [provider, role] of Object.entries(providers)) {
			h.ctx.model!.provider = provider;
			h.footer!.render(400);
			expect(h.roles).toContainEqual([role, provider]);
		}
		for (const [level, role] of Object.entries({
			minimal: "thinkingMinimal",
			low: "thinkingLow",
			medium: "thinkingMedium",
			high: "thinkingHigh",
			xhigh: "thinkingXhigh",
			max: "thinkingMax",
		} as const)) {
			h.setLevel(level);
			h.footer!.render(400);
			expect(h.roles).toContainEqual([role, level]);
		}
		for (const [cacheRead, role] of [
			[20, "error"],
			[50, "warning"],
			[80, "success"],
		] as const) {
			h.setEntries([assistantEntry(100 - cacheRead, 1, cacheRead, 0, 0)]);
			h.footer!.render(400);
			expect(h.roles).toContainEqual([role, `${cacheRead}.0%`]);
		}
		for (const [percent, role] of [
			[20, "accent"],
			[80, "warning"],
			[95, "error"],
			[130, "error"],
		] as const) {
			h.setUsage({ tokens: 1_000, contextWindow: 200_000, percent });
			h.footer!.render(400);
			expect(h.roles).toContainEqual([role, `${percent}.0%`]);
		}
	});

	test("missing model/context/cache and path boundaries remain safe", async () => {
		const h = createHarness();
		h.ctx.model = undefined;
		h.setCwd(`${process.env.HOME}-other/project`);
		h.setBranch(null);
		h.setSessionName(undefined);
		h.setEntries([assistantEntry(0, 0, 0, 0, 0)]);
		h.setUsage({ tokens: null, contextWindow: 200_000, percent: null });
		await h.emit("session_start", { reason: "startup" });
		expect(footerText(h)).toHaveLength(1);
		expect(footerText(h)[0]).toStartWith(`${process.env.HOME}-other/project`);
		expect(footerText(h)[0]).toEndWith("none ▪ no-model");
		h.setCwd(process.env.HOME!);
		expect(footerText(h)[0]).toStartWith("~ ");
		h.setUsage({ tokens: 0, contextWindow: 200_000, percent: 0 });
		expect(footerText(h)).toHaveLength(1);
	});
});
