import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentSessionEvent, EventBus } from "@earendil-works/pi-coding-agent";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";

export interface UsageCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number | undefined;
	totalTokens: number;
	cost: number;
	/** Model turns reported by the subagent manager's UsageStats; provider usage leaves this undefined. */
	turns: number | undefined;
}

export function emptyUsage(): UsageCounts {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: undefined,
		totalTokens: 0,
		cost: 0,
		turns: undefined,
	};
}

export function addUsage(target: UsageCounts, delta: UsageCounts): void {
	target.input += delta.input;
	target.output += delta.output;
	target.cacheRead += delta.cacheRead;
	target.cacheWrite += delta.cacheWrite;
	target.totalTokens += delta.totalTokens;
	target.cost += delta.cost;
	if (delta.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + delta.reasoning;
	if (delta.turns !== undefined) target.turns = (target.turns ?? 0) + delta.turns;
}

function numberOrZero(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function usageFromUnknown(value: unknown): UsageCounts {
	const usage = (value ?? {}) as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
		reasoning?: unknown;
		totalTokens?: unknown;
		cost?: { total?: unknown } | number;
		turns?: unknown;
	};
	const cost =
		typeof usage.cost === "number" ? usage.cost : typeof usage.cost?.total === "number" ? usage.cost.total : 0;
	return {
		input: numberOrZero(usage.input),
		output: numberOrZero(usage.output),
		cacheRead: numberOrZero(usage.cacheRead),
		cacheWrite: numberOrZero(usage.cacheWrite),
		reasoning: typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning) ? usage.reasoning : undefined,
		totalTokens:
			typeof usage.totalTokens === "number" && usage.totalTokens > 0
				? usage.totalTokens
				: numberOrZero(usage.input) +
					numberOrZero(usage.output) +
					numberOrZero(usage.cacheRead) +
					numberOrZero(usage.cacheWrite),
		cost,
		turns: typeof usage.turns === "number" && Number.isFinite(usage.turns) ? usage.turns : undefined,
	};
}

export interface BenchTaskSnapshot {
	id: string;
	agent: string;
	status: string;
	task: string;
	sessionId: string | undefined;
	sessionFile: string | undefined;
	startedAt: number | undefined;
	endedAt: number | undefined;
	toolCalls: number | undefined;
	usage: UsageCounts | undefined;
	finalText: string | undefined;
	error: string | undefined;
	model: string | undefined;
	provider: string | undefined;
	thinking: string | undefined;
	tools: string[] | undefined;
	branch: string | undefined;
	isolation: string | undefined;
}

export interface BenchRunSnapshot {
	id: string;
	mode: string | undefined;
	status: string | undefined;
	createdAt: number | undefined;
	startedAt: number | undefined;
	endedAt: number | undefined;
	tasks: BenchTaskSnapshot[];
}

export function runSnapshotFromUnknown(value: unknown): BenchRunSnapshot | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const run = value as Record<string, unknown>;
	if (typeof run.id !== "string") return undefined;
	const tasks = Array.isArray(run.tasks) ? run.tasks : [];
	return {
		id: run.id,
		mode: typeof run.mode === "string" ? run.mode : undefined,
		status: typeof run.status === "string" ? run.status : undefined,
		createdAt: typeof run.createdAt === "number" ? run.createdAt : undefined,
		startedAt: typeof run.startedAt === "number" ? run.startedAt : undefined,
		endedAt: typeof run.endedAt === "number" ? run.endedAt : undefined,
		tasks: tasks.map((task) => {
			const t = task as Record<string, unknown>;
			return {
				id: String(t.id ?? "?"),
				agent: String(t.agent ?? "?"),
				status: String(t.status ?? "?"),
				task: String(t.task ?? ""),
				sessionId: typeof t.sessionId === "string" ? t.sessionId : undefined,
				sessionFile: typeof t.sessionFile === "string" ? t.sessionFile : undefined,
				startedAt: typeof t.startedAt === "number" ? t.startedAt : undefined,
				endedAt: typeof t.endedAt === "number" ? t.endedAt : undefined,
				toolCalls: typeof t.toolCalls === "number" ? t.toolCalls : undefined,
				usage: t.usage === undefined ? undefined : usageFromUnknown(t.usage),
				finalText: typeof t.finalText === "string" ? t.finalText : undefined,
				error: typeof t.error === "string" ? t.error : undefined,
				model: typeof t.model === "string" ? t.model : undefined,
				provider: typeof t.provider === "string" ? t.provider : undefined,
				thinking: typeof t.thinking === "string" ? t.thinking : undefined,
				tools: Array.isArray(t.tools) ? t.tools.map(String) : undefined,
				branch: typeof t.branch === "string" ? t.branch : undefined,
				isolation: typeof t.isolation === "string" ? t.isolation : undefined,
			};
		}),
	};
}

export interface ToolRecord {
	toolCallId: string;
	toolName: string;
	startMs: number;
	endMs: number | undefined;
	isError: boolean | undefined;
	argsPreview: string;
	resultText: string | undefined;
	run: BenchRunSnapshot | undefined;
	updates: number;
}

export interface MessageRecord {
	atMs: number;
	role: string;
	usage: UsageCounts | undefined;
	stopReason: string | undefined;
	errorMessage: string | undefined;
	textChars: number;
	thinkingChars: number;
}

export interface BusNotification {
	atMs: number;
	runId: string | undefined;
	taskId: string | undefined;
	kind: string | undefined;
	body: string | undefined;
}

export class Probe {
	readonly t0: number;
	now(): number {
		return performance.now() - this.t0;
	}
	constructor(t0 = performance.now()) {
		this.t0 = t0;
	}

	promptAtMs: number | undefined;
	promptReturnMs: number | undefined;
	firstMessageUpdateMs: number | undefined;
	firstThinkingMs: number | undefined;
	firstTextMs: number | undefined;
	firstAssistantMessageMs: number | undefined;
	settledAtMs: number | undefined;
	lastSettledAtMs: number | undefined;
	settledCount = 0;
	agentStarts = 0;
	turnStarts = 0;
	retries = 0;
	errors: string[] = [];
	messages: MessageRecord[] = [];
	tools: ToolRecord[] = [];
	private openTools = new Map<string, ToolRecord>();

	handle(event: AgentSessionEvent): void {
		const at = this.now();
		switch (event.type) {
			case "agent_start":
				this.agentStarts += 1;
				break;
			case "agent_settled":
				this.settledCount += 1;
				this.settledAtMs ??= at;
				this.lastSettledAtMs = at;
				break;
			case "turn_start":
				this.turnStarts += 1;
				break;
			case "auto_retry_start":
				this.retries += 1;
				this.errors.push(`auto_retry: ${event.errorMessage}`);
				break;
			case "message_update":
				this.firstMessageUpdateMs ??= at;
				if (event.assistantMessageEvent.type === "thinking_delta") this.firstThinkingMs ??= at;
				if (event.assistantMessageEvent.type === "text_delta") {
					this.firstTextMs ??= at;
					this.firstAssistantMessageMs ??= at;
				}
				break;
			case "message_end": {
				const message = event.message as {
					role?: string;
					usage?: unknown;
					stopReason?: string;
					errorMessage?: string;
					content?: unknown;
				};
				const role = String(message.role ?? "?");
				if (role === "assistant") {
					this.firstAssistantMessageMs ??= at;
					const usage = usageFromUnknown(message.usage);
					this.messages.push({
						atMs: at,
						role,
						usage,
						stopReason: message.stopReason,
						errorMessage: message.errorMessage,
						textChars: contentChars(message.content, "text"),
						thinkingChars: contentChars(message.content, "thinking"),
					});
					if (message.stopReason === "error" || message.errorMessage) {
						this.errors.push(`assistant_error: ${message.errorMessage ?? message.stopReason}`);
					}
				} else {
					this.messages.push({
						atMs: at,
						role,
						usage: undefined,
						stopReason: undefined,
						errorMessage: undefined,
						textChars: contentChars(message.content, "text"),
						thinkingChars: 0,
					});
				}
				break;
			}
			case "tool_execution_start": {
				const record: ToolRecord = {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					startMs: at,
					endMs: undefined,
					isError: undefined,
					argsPreview: preview(event.args),
					resultText: undefined,
					run: undefined,
					updates: 0,
				};
				this.openTools.set(event.toolCallId, record);
				this.tools.push(record);
				break;
			}
			case "tool_execution_update": {
				const record = this.openTools.get(event.toolCallId);
				if (record) record.updates += 1;
				break;
			}
			case "tool_execution_end": {
				const record = this.openTools.get(event.toolCallId);
				if (record) {
					record.endMs = at;
					record.isError = event.isError;
					const result = event.result as { content?: unknown; details?: unknown } | undefined;
					record.resultText = contentText(result?.content);
					record.run = runSnapshotFromUnknown((result?.details as { run?: unknown } | undefined)?.run);
					this.openTools.delete(event.toolCallId);
				}
				break;
			}
			default:
				break;
		}
	}

	assistantUsage(): UsageCounts {
		const total = emptyUsage();
		for (const message of this.messages) {
			if (message.role === "assistant" && message.usage) addUsage(total, message.usage);
		}
		return total;
	}

	assistantCalls(): number {
		return this.messages.filter((message) => message.role === "assistant").length;
	}

	toolCalls(): number {
		return this.tools.length;
	}

	lastRun(): BenchRunSnapshot | undefined {
		for (let i = this.tools.length - 1; i >= 0; i--) {
			const run = this.tools[i]?.run;
			if (run) return run;
		}
		return undefined;
	}

	latestRunForTool(toolName: string): BenchRunSnapshot | undefined {
		for (let i = this.tools.length - 1; i >= 0; i--) {
			if (this.tools[i]?.toolName === toolName && this.tools[i]?.run) return this.tools[i]?.run;
		}
		return undefined;
	}
}

function preview(value: unknown): string {
	try {
		if (value === undefined) return "";
		const text = typeof value === "string" ? value : JSON.stringify(value);
		return text.length > 400 ? `${text.slice(0, 400)}…` : text;
	} catch {
		return "";
	}
}

function contentChars(content: unknown, kind: "text" | "thinking"): number {
	if (!Array.isArray(content)) return 0;
	let total = 0;
	for (const block of content) {
		const entry = block as { type?: unknown; text?: unknown };
		if (entry.type === kind && typeof entry.text === "string") total += entry.text.length;
	}
	return total;
}

function contentText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		const entry = block as { type?: unknown; text?: unknown };
		if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
	}
	return parts.join("\n");
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "aborted"]);

export function collectRuns(tools: ToolRecord[]): BenchRunSnapshot[] {
	const runs = new Map<string, BenchRunSnapshot>();
	for (const tool of tools) {
		const run = tool.run;
		if (!run) continue;
		const previous = runs.get(run.id);
		const previousRank = previous?.endedAt ?? previous?.startedAt ?? previous?.createdAt ?? 0;
		const rank = run.endedAt ?? run.startedAt ?? run.createdAt ?? 0;
		if (!previous || rank >= previousRank) runs.set(run.id, run);
	}
	return [...runs.values()];
}

export function pickRunSnapshot(tools: ToolRecord[], preferRunId?: string): BenchRunSnapshot | undefined {
	const runs = collectRuns(tools);
	if (preferRunId) {
		const preferred = runs.find((run) => run.id === preferRunId);
		if (preferred) return preferred;
	}
	const terminal = runs.filter((run) => run.status !== undefined && TERMINAL_STATUSES.has(run.status));
	const pool = terminal.length > 0 ? terminal : runs;
	return pool.sort((a, b) => (b.endedAt ?? b.createdAt ?? 0) - (a.endedAt ?? a.createdAt ?? 0))[0];
}

export function routingSequence(tools: ToolRecord[]): Array<{
	tool: string;
	atMs: number;
	endMs: number | undefined;
	isError: boolean | undefined;
	argsPreview: string;
}> {
	return tools.map((tool) => ({
		tool: tool.toolName,
		atMs: tool.startMs,
		endMs: tool.endMs,
		isError: tool.isError,
		argsPreview: tool.argsPreview,
	}));
}

/** True when a captured tool-arguments preview carries `key: true`, tolerating pretty-printed spacing. */
export function argsFlag(argsPreview: string | undefined, key: string): boolean {
	if (!argsPreview) return false;
	try {
		const parsed = JSON.parse(argsPreview) as Record<string, unknown>;
		if (parsed[key] === true) return true;
	} catch {
		// fall through to the tolerant regex
	}
	return new RegExp(`"${key}"\\s*:\\s*true`).test(argsPreview);
}

export function captureBusNotifications(
	eventBus: EventBus,
	t0: number,
): { notifications: BusNotification[]; unsubscribe: () => void } {
	const notifications: BusNotification[] = [];
	const unsubscribe = eventBus.on("subagent:notification", (data) => {
		const payload = (data ?? {}) as Record<string, unknown>;
		notifications.push({
			atMs: performance.now() - t0,
			runId: typeof payload.runId === "string" ? payload.runId : undefined,
			taskId: typeof payload.taskId === "string" ? payload.taskId : undefined,
			kind: typeof payload.kind === "string" ? payload.kind : undefined,
			body: typeof payload.body === "string" ? payload.body : undefined,
		});
	});
	return { notifications, unsubscribe };
}

export interface ChildSessionMetrics {
	sessionFile: string;
	messageCount: number;
	userMessages: number;
	assistantMessages: number;
	toolCallCount: number;
	toolResultCount: number;
	usage: UsageCounts;
	finalText: string | undefined;
	containsBenchOk: boolean;
	firstUserAt: number | undefined;
	firstAssistantAt: number | undefined;
	lastAssistantAt: number | undefined;
	model: string | undefined;
	provider: string | undefined;
	thinkingLevel: string | undefined;
	errors: string[];
}

export function parseChildSessionFile(sessionFile: string): ChildSessionMetrics | null {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return null;
	}
	const entries = parseSessionEntries(content);
	const metrics: ChildSessionMetrics = {
		sessionFile,
		messageCount: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolCallCount: 0,
		toolResultCount: 0,
		usage: emptyUsage(),
		finalText: undefined,
		containsBenchOk: false,
		firstUserAt: undefined,
		firstAssistantAt: undefined,
		lastAssistantAt: undefined,
		model: undefined,
		provider: undefined,
		thinkingLevel: undefined,
		errors: [],
	};
	for (const entry of entries) {
		const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
		if (entry.type === "model_change") {
			metrics.model = entry.modelId;
			metrics.provider = entry.provider;
			continue;
		}
		if (entry.type === "thinking_level_change") {
			metrics.thinkingLevel = entry.thinkingLevel;
			continue;
		}
		if (entry.type !== "message") continue;
		metrics.messageCount += 1;
		const message = entry.message as {
			role?: string;
			usage?: unknown;
			model?: string;
			provider?: string;
			content?: unknown;
			stopReason?: string;
			errorMessage?: string;
		};
		const role = String(message.role ?? "");
		if (role === "user") {
			metrics.userMessages += 1;
			if (Number.isFinite(at)) metrics.firstUserAt ??= at;
			continue;
		}
		if (role === "toolResult") {
			metrics.toolResultCount += 1;
			continue;
		}
		if (role !== "assistant") continue;
		metrics.assistantMessages += 1;
		if (Number.isFinite(at)) {
			metrics.firstAssistantAt ??= at;
			metrics.lastAssistantAt = at;
		}
		if (message.model) metrics.model ??= message.model;
		if (message.provider) metrics.provider ??= message.provider;
		addUsage(metrics.usage, usageFromUnknown(message.usage));
		if (message.stopReason === "error" || message.errorMessage) {
			metrics.errors.push(message.errorMessage ?? String(message.stopReason));
		}
		const blocks = Array.isArray(message.content) ? message.content : [];
		let lastText = "";
		for (const block of blocks) {
			const item = block as { type?: unknown; text?: unknown };
			if (item.type === "toolCall") metrics.toolCallCount += 1;
			if (item.type === "text" && typeof item.text === "string") lastText += item.text;
		}
		if (lastText) {
			metrics.finalText = lastText;
			if (lastText.includes("BENCH_OK")) metrics.containsBenchOk = true;
		}
	}
	return metrics;
}

export function findRecentSessionFiles(agentDir: string, sinceMs: number): string[] {
	const root = join(agentDir, "sessions");
	const found: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 3) return;
		let entries: Array<{
			isDirectory(): boolean;
			isFile(): boolean;
			name: string;
		}>;
		try {
			entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
				isDirectory(): boolean;
				isFile(): boolean;
				name: string;
			}>;
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(path, depth + 1);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			try {
				if (statSync(path).mtimeMs >= sinceMs) found.push(path);
			} catch {}
		}
	};
	walk(root, 0);
	return found.sort();
}

export function findChildSession(
	agentDir: string,
	sinceMs: number,
	needle = "BENCH_OK",
): { sessionFile: string; metrics: ChildSessionMetrics } | undefined {
	const candidates = findRecentSessionFiles(agentDir, sinceMs);
	let best: { sessionFile: string; metrics: ChildSessionMetrics } | undefined;
	for (const file of candidates) {
		const metrics = parseChildSessionFile(file);
		if (!metrics) continue;
		if (!metrics.containsBenchOk && !(metrics.finalText ?? "").includes(needle)) continue;
		if (!best || (metrics.lastAssistantAt ?? 0) >= (best.metrics.lastAssistantAt ?? 0)) {
			best = { sessionFile: file, metrics };
		}
	}
	return best;
}
