/**
 * Senja — fork of pi-haiku 0.2.0 by nocte (MIT).
 *
 * Layout:
 *   • Line 1: location left, provider ▪ model ▪ effort right
 *   • Line 2: working/done timer + stats left, context bar + % + size right
 *   • Line 3 (optional): raw extension statuses
 *
 * Usage:
 *   /senja       Toggle on/off
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage, ThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ── Visual primitives ────────────────────────────────────────────────────────

const GLYPH = {
	dot: "·",
	square: "▪",
	barFull: "█",
	barEmpty: "░",
	bracketL: "[",
	bracketR: "]",
	pipe: "|",
} as const;

interface RenderHandle {
	requestRender(): void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Replace $HOME with ~, mirroring Pi's built-in footer logic. */
function formatCwd(cwd: string): string {
	const home = process.env.HOME || process.env.USERPROFILE;
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const insideHome = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));

	if (!insideHome) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** Compact token formatter. */
function fmtTokens(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** Format milliseconds as a human-readable duration. */
function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;

	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return `${h}h ${m}m ${s}s`;
}

/** Right-align two text blocks, truncating left if they don't both fit. */
function alignRight(left: string, right: string, width: number, theme: Theme): string {
	const rightW = visibleWidth(right);
	if (rightW > width) {
		right = truncateToWidth(right, width, theme.fg("dim", "…"));
	}
	const leftW = visibleWidth(left);
	const rightW2 = visibleWidth(right);
	const pad = width - leftW - rightW2;
	if (pad >= 1) {
		return left + " ".repeat(pad) + right;
	}
	const availableForLeft = Math.max(0, width - rightW2 - 1);
	const truncatedLeft = availableForLeft > 0 ? truncateToWidth(left, availableForLeft, theme.fg("dim", "…")) : "";
	return truncatedLeft ? `${truncatedLeft} ${right}` : right;
}

/** Theme color for a provider name. */
function providerColor(provider: string): ThemeColor {
	switch (provider.toLowerCase()) {
		case "anthropic":
			return "accent";
		case "openai":
		case "openai-codex":
			return "success";
		case "google":
		case "google-vertex":
			return "warning";
		case "amazon-bedrock":
			return "thinkingHigh";
		case "github-copilot":
			return "mdLink";
		case "deepseek":
			return "thinkingLow";
		case "xai":
		case "groq":
			return "error";
		case "opencode-go":
			return "accent";
		default:
			return "muted";
	}
}

/** Theme color for an effort/thinking level. */
function effortColor(level: ThinkingLevel | string | undefined): ThemeColor {
	switch (level) {
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "thinkingMedium";
	}
}

/** Color scale for percentage values (context usage / cache hit). */
function stressColor(value: number, warn = 70, danger = 90): ThemeColor {
	if (value >= danger) return "error";
	if (value >= warn) return "warning";
	return "accent";
}

/** Color scale for cache-hit percentage: low is red, high is green. */
function cacheHitColor(value: number): ThemeColor {
	if (value < 30) return "error";
	if (value < 70) return "warning";
	return "success";
}

/** Render a horizontal progress bar. */
function renderBar(theme: Theme, pct: number, barWidth: number): string {
	const filled = Math.max(0, Math.min(barWidth, Math.round((pct / 100) * barWidth)));
	const empty = barWidth - filled;
	const color = stressColor(pct, 70, 90);

	return (
		theme.fg("dim", GLYPH.bracketL) +
		theme.fg(color, GLYPH.barFull.repeat(filled)) +
		theme.fg("dim", GLYPH.barEmpty.repeat(empty)) +
		theme.fg("dim", GLYPH.bracketR)
	);
}

function sanitizeStatus(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => (/^\x1b\[[0-9;:]*m$/.test(sequence) ? sequence : ""))
		.replace(/[\r\n\t]/g, " ")
		.replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f]|\x1b(?!\[[0-9;:]*m)/g, "")
		.replace(/ +/g, " ")
		.trim();
}

function renderHeader(theme: Theme, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];

	// Column grid: 2-space indent · 8-wide eyebrow · 2-space gap · content.
	const INDENT = 2;
	const EYEBROW_W = 8;
	const GAP = 2;
	const contentStart = INDENT + EYEBROW_W + GAP;
	const contentWidth = Math.max(0, width - contentStart);

	// A keybinding pair: the key glows in accent, the verb sits quiet in dim.
	const pair = (key: string, desc: string) => `${theme.fg("accent", key)} ${theme.fg("dim", desc)}`;
	const sep = theme.fg("dim", " · ");
	const ellipsis = theme.fg("dim", "…");

	// Greedy flow: pack pairs into the content column, wrapping under the
	// eyebrow when a line would overflow. Continuation lines align with the
	// first content column so the key map reads as a tidy block.
	const flowGroup = (label: string, pairs: string[]): string[] => {
		const out: string[] = [];
		const prefix =
			" ".repeat(INDENT) +
			theme.fg("warning", label) +
			" ".repeat(Math.max(1, EYEBROW_W - visibleWidth(label))) +
			" ".repeat(GAP);
		let line = prefix;
		let lineW = contentStart;

		for (const seg of pairs) {
			const segW = visibleWidth(seg);
			if (lineW === contentStart) {
				const fit = segW <= contentWidth ? seg : truncateToWidth(seg, contentWidth, ellipsis);
				line += fit;
				lineW += visibleWidth(fit);
			} else if (lineW + visibleWidth(sep) + segW <= width) {
				line += sep + seg;
				lineW += visibleWidth(sep) + segW;
			} else {
				out.push(line);
				const fit = segW <= contentWidth ? seg : truncateToWidth(seg, contentWidth, ellipsis);
				line = " ".repeat(contentStart) + fit;
				lineW = contentStart + visibleWidth(fit);
			}
		}
		out.push(line);
		return out;
	};

	// --- Identity line: bold accent "pi", muted version, no leading spacing ---
	lines.push(`${theme.bold(theme.fg("accent", "pi"))} ${theme.fg("muted", `v${VERSION}`)}`);
	lines.push("");

	// --- Key map, grouped by intent ---
	lines.push(
		...flowGroup("control", [
			pair("esc", "interrupt"),
			pair("ctrl+c", "clear"),
			pair("ctrl+d", "exit"),
			pair("ctrl+z", "suspend"),
			pair("ctrl+k", "delete to end"),
		]),
		...flowGroup("models", [
			pair("ctrl+p", "next"),
			pair("shift+ctrl+p", "prev"),
			pair("ctrl+l", "select"),
			pair("shift+tab", "thinking"),
		]),
		...flowGroup("view", [pair("ctrl+o", "tools"), pair("ctrl+t", "thinking"), pair("ctrl+g", "editor")]),
		...flowGroup("input", [
			pair("/", "commands"),
			pair("!", "bash"),
			pair("!!", "bash·nc"),
			pair("alt+enter", "follow-up"),
			pair("alt+up", "queue"),
			pair("ctrl+v", "image"),
			pair("drop", "attach files"),
		]),
	);

	// --- Hint ---
	lines.push("");
	lines.push(" ".repeat(INDENT) + theme.fg("muted", "Pi can explain its own features and look up its docs."));

	return lines.map((line) => truncateToWidth(line, width, ellipsis));
}

function applyHeader(ctx: ExtensionContext): void {
	ctx.ui.setHeader((_tui, theme) => ({
		render(width: number): string[] {
			return renderHeader(theme, width);
		},
		invalidate() {},
	}));
}

function restoreHeader(ctx: ExtensionContext): void {
	ctx.ui.setHeader(undefined);
}

/** Clear the visible screen and home the cursor on initial launch.
 *
 * This pushes the shell prompt and pre-Pi output out of view while keeping the
 * normal screen buffer, so the mouse wheel can still scroll the terminal page.
 * Scrollback is preserved.
 */
function clearVisibleScreenOnStartup(): void {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[2J\x1b[H");
	}
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let renderHandle: RenderHandle | undefined;
	let disposeFooter: (() => void) | undefined;
	let enabled = true;
	let workingSince: number | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let lastDoneIn: number | undefined;
	let modeWorkingMessage: string | undefined;

	const unsubscribeMode = pi.events.on("pi-mode:working-message", (message) => {
		if (message === undefined || typeof message === "string") modeWorkingMessage = message || undefined;
	});

	function requestFooterRender(): void {
		renderHandle?.requestRender();
	}

	function clearWorkingTimers(): void {
		if (workingTimer !== undefined) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	}

	// Re-render when state that the footer displays changes.
	pi.on("thinking_level_select", requestFooterRender);
	pi.on("model_select", requestFooterRender);

	// Track how long the current prompt has been running.
	pi.on("agent_start", (_event, ctx) => {
		clearWorkingTimers();
		workingSince = Date.now();
		lastDoneIn = undefined;

		if (ctx.mode !== "tui") return;

		const tick = () => {
			if (workingSince === undefined) return;
			const elapsed = formatDuration(Date.now() - workingSince);
			try {
				ctx.ui.setWorkingMessage(`${modeWorkingMessage ?? "Working…"} ${elapsed}`);
			} catch {
				// Ignore if the UI is already torn down.
			}
			requestFooterRender();
		};

		tick();
		workingTimer = setInterval(tick, 250);
	});

	// Report final duration and clean up timers.
	pi.on("agent_end", (_event, ctx) => {
		clearWorkingTimers();

		if (workingSince !== undefined) {
			lastDoneIn = Date.now() - workingSince;
			workingSince = undefined;
		}

		requestFooterRender();

		// Show a notification and working message with the total elapsed time.
		// The working message area may be hidden after streaming ends, so we
		// make it visible first. The footer also displays this until the next task.
		if (lastDoneIn !== undefined && ctx.mode === "tui") {
			try {
				ctx.ui.setWorkingVisible(true);
				ctx.ui.setWorkingMessage(`Worked for ${formatDuration(lastDoneIn)}`);
				ctx.ui.notify(`Worked for ${formatDuration(lastDoneIn)}`, "info");
			} catch {
				// Ignore if the UI is already torn down.
			}
		}
	});

	function applyFooter(ctx: ExtensionContext): void {
		disposeFooter?.();
		ctx.ui.setFooter((tui, theme, footerData) => {
			disposeFooter?.();
			renderHandle = tui;
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
			let disposed = false;
			const dispose = () => {
				if (disposed) return;
				disposed = true;
				unsubscribeBranch();
				if (disposeFooter === dispose) {
					disposeFooter = undefined;
					renderHandle = undefined;
				}
			};
			disposeFooter = dispose;

			return {
				dispose,
				invalidate() {
					// Stateless render; nothing to cache.
				},
				render(width: number): string[] {
					if (width <= 0) return [];
					// ── Aggregate usage across every assistant message ───────────────
					let totalInput = 0;
					let totalOutput = 0;
					let totalCost = 0;
					let latestCacheHitRate: number | undefined;

					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCost += m.usage.cost.total;

							const promptTokens = m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
							latestCacheHitRate = promptTokens > 0 ? (m.usage.cacheRead / promptTokens) * 100 : undefined;
						}
					}

					// ── Context usage for the active model ───────────────────────────
					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const contextTokens = contextUsage?.tokens ?? null;
					const contextPercent = contextUsage?.percent ?? null;
					const contextPctValue = contextPercent ?? 0;

					// ── Location / session metadata ──────────────────────────────────
					const cwd = sanitizeStatus(formatCwd(ctx.sessionManager.getCwd()));
					const branch = sanitizeStatus(footerData.getGitBranch() ?? "");
					const sessionName = sanitizeStatus(ctx.sessionManager.getSessionName() ?? "");

					// ── Provider / model / effort metadata ───────────────────────────
					const provider = sanitizeStatus(ctx.model?.provider ?? "none");
					const modelId = sanitizeStatus(ctx.model?.id ?? "no-model");
					const reasoning = ctx.model?.reasoning ?? false;
					const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;

					// ── Line 1: location left, provider ▪ model ▪ effort right ───────
					let locationBlock = theme.fg("accent", cwd);
					if (branch) {
						locationBlock += ` ${theme.fg("dim", "branch")} ${theme.fg("success", branch)}`;
					}
					if (sessionName) {
						locationBlock += ` ${theme.fg("dim", "session")} ${theme.fg("text", sessionName)}`;
					}

					let modelBlock = `${theme.fg(providerColor(provider), String(provider))} ${theme.fg("dim", GLYPH.square)} ${theme.fg("text", modelId)}`;
					if (reasoning) {
						const level = pi.getThinkingLevel();
						modelBlock += ` ${theme.fg("dim", GLYPH.square)} ${theme.fg(effortColor(level), level)}`;
					}

					const line1 = alignRight(locationBlock, modelBlock, width, theme);

					// ── Line 2: working/done timer + stats left, context right ───────
					const stats: string[] = [];

					if (totalInput > 0) {
						stats.push(`${theme.fg("dim", "in")} ${theme.fg("accent", `↑${fmtTokens(totalInput)}`)}`);
					}
					if (totalOutput > 0) {
						stats.push(`${theme.fg("dim", "out")} ${theme.fg("success", `↓${fmtTokens(totalOutput)}`)}`);
					}
					if (latestCacheHitRate !== undefined) {
						stats.push(
							`${theme.fg("dim", "cache hit")} ${theme.fg(
								cacheHitColor(latestCacheHitRate),
								`${latestCacheHitRate.toFixed(1)}%`,
							)}`,
						);
					}

					if (totalCost > 0) {
						const costText = `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
						stats.push(`${theme.fg("dim", "cost")} ${theme.fg("warning", costText)}`);
					}

					const statsBlock = stats.join(` ${theme.fg("dim", GLYPH.pipe)} `);

					let contextBlock = "";
					if (contextTokens !== null && contextTokens > 0) {
						const pctText = theme.fg(stressColor(contextPctValue, 70, 90), `${contextPctValue.toFixed(1)}%`);
						const contextText = `${theme.fg("text", fmtTokens(contextTokens))}${theme.fg("dim", "/")}${theme.fg("text", fmtTokens(contextWindow))}`;
						// Fit the context block within the available width so the right-hand
						// numbers aren't truncated (e.g. 50k/500k becoming 50k/5...).
						const reserved = visibleWidth(pctText) + visibleWidth(contextText) + 4 + 2; // separators + brackets
						const barWidth = Math.max(6, Math.min(16, width - reserved));
						contextBlock = `${renderBar(theme, contextPctValue, barWidth)} ${pctText} ${theme.fg("dim", GLYPH.square)} ${contextText}`;
					}

					let timerBlock = "";
					if (workingSince !== undefined) {
						timerBlock = `${theme.fg("dim", "working")} ${theme.fg("accent", formatDuration(Date.now() - workingSince))}`;
					} else if (lastDoneIn !== undefined) {
						timerBlock = `${theme.fg("success", "worked")} ${theme.fg("text", `for ${formatDuration(lastDoneIn)}`)}`;
					}

					let rightBlock = statsBlock;
					if (contextBlock) {
						rightBlock = rightBlock ? alignRight(rightBlock, contextBlock, width, theme) : contextBlock;
					}

					let line2: string | undefined;
					if (timerBlock && rightBlock) {
						line2 = alignRight(timerBlock, rightBlock, width, theme);
					} else if (timerBlock) {
						line2 = timerBlock;
					} else if (rightBlock) {
						line2 = rightBlock;
					}

					// ── Optional line 3: raw extension statuses ──────────────────────
					const lines: string[] = [line1];
					if (line2) {
						lines.push(line2);
					}
					const extensionStatuses = footerData.getExtensionStatuses();

					if (extensionStatuses.size > 0) {
						const divider = ` ${GLYPH.pipe} `;
						const rawStatuses = Array.from(extensionStatuses.entries())
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text]) => sanitizeStatus(text))
							.filter((text) => text.length > 0)
							.join(divider);
						if (rawStatuses) {
							lines.push(theme.fg("dim", rawStatuses));
						}
					}

					// Truncate every line to exact terminal width; no trailing spacing.
					return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "…")));
				},
			};
		});
	}

	function restoreFooter(ctx: ExtensionContext): void {
		disposeFooter?.();
		ctx.ui.setFooter(undefined);
	}

	// Toggle command.
	pi.registerCommand("senja", {
		description: "Toggle the Senja header and footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("Senja requires terminal UI mode", "info");
				return;
			}
			enabled = !enabled;
			if (enabled) {
				applyFooter(ctx);
				applyHeader(ctx);
				ctx.ui.notify("Senja enabled", "info");
			} else {
				restoreFooter(ctx);
				restoreHeader(ctx);
				ctx.ui.notify("Default UI restored", "info");
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		clearWorkingTimers();
		workingSince = undefined;
		lastDoneIn = undefined;
		disposeFooter?.();
		if (ctx.mode !== "tui") return;

		if (event.reason === "startup") {
			clearVisibleScreenOnStartup();
		}

		const result = ctx.ui.setTheme("senja");
		if (!result.success) {
			ctx.ui.notify(`Senja theme: ${result.error ?? "unknown error"}`, "warning");
		}

		if (enabled) {
			applyFooter(ctx);
			applyHeader(ctx);
		} else {
			restoreFooter(ctx);
			restoreHeader(ctx);
		}
	});

	pi.on("session_shutdown", () => {
		unsubscribeMode();
		modeWorkingMessage = undefined;
		clearWorkingTimers();
		workingSince = undefined;
		lastDoneIn = undefined;
		disposeFooter?.();
		renderHandle = undefined;
	});
}
