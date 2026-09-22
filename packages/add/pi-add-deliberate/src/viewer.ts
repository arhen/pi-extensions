import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export const OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const HEADER_LINES = 2;
const FOOTER_LINES = 1;
const WHEEL_STEP = 3;

export interface ViewportSlice {
	offset: number;
	lines: string[];
}

export function clampOffset(offset: number, total: number, height: number): number {
	const size = Math.max(1, Math.floor(height));
	const maxOffset = Math.max(0, total - size);
	return Math.min(Math.max(0, Math.floor(offset)), maxOffset);
}

/** Slice a bounded viewport out of the rendered Markdown lines, clamping the offset. */
export function sliceViewport(lines: readonly string[], offset: number, height: number): ViewportSlice {
	const size = Math.max(1, Math.floor(height));
	const next = clampOffset(offset, lines.length, size);
	return { offset: next, lines: lines.slice(next, next + size) };
}

/** SGR mouse wheel events, when the terminal forwards them (wheel up = 64, wheel down = 65). */
export function parseWheelInput(data: string): number | null {
	const match = /^\u001b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
	if (!match) return null;
	const button = Number(match[1]);
	if (button === 64) return -1;
	if (button === 65) return 1;
	return null;
}

export interface PlanViewerOptions {
	tui: TUI;
	theme: Theme;
	markdownTheme: MarkdownTheme;
	title: string;
	path: string;
	content: string | null;
	warning?: string;
	onClose: () => void;
}

/**
 * Manual sliced viewport over rendered Markdown lines. The overlay maxHeight
 * truncates from the top, so the component reserves its own header/footer and
 * never renders more lines than the overlay can show.
 */
export class PlanViewer implements Component {
	private readonly options: PlanViewerOptions;
	private markdown: Markdown | null = null;
	private offset = 0;
	private bodyLength = 0;

	constructor(options: PlanViewerOptions) {
		this.options = options;
	}

	private reservedLines(): number {
		return HEADER_LINES + FOOTER_LINES + (this.options.warning ? 1 : 0);
	}

	private bodyHeight(): number {
		const overlayHeight = Math.max(4, Math.floor(this.options.tui.terminal.rows * OVERLAY_MAX_HEIGHT_RATIO));
		return Math.max(1, overlayHeight - this.reservedLines());
	}

	private bodyLines(width: number): string[] {
		if (this.options.content === null) return [this.options.theme.fg("error", "Plan file is not readable.")];
		if (!this.markdown) this.markdown = new Markdown(this.options.content, 0, 0, this.options.markdownTheme);
		const lines = this.markdown.render(Math.max(1, width));
		return lines.length > 0 ? lines : [""];
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const body = this.bodyLines(safeWidth);
		this.bodyLength = body.length;
		const slice = sliceViewport(body, this.offset, this.bodyHeight());
		this.offset = slice.offset;
		const header = [
			truncateToWidth(this.options.theme.fg("accent", this.options.title), safeWidth),
			truncateToWidth(this.options.theme.fg("dim", this.options.path), safeWidth),
		];
		if (this.options.warning) {
			header.push(truncateToWidth(this.options.theme.fg("warning", this.options.warning), safeWidth));
		}
		const position =
			body.length > slice.lines.length
				? ` · ${slice.offset + 1}-${slice.offset + slice.lines.length}/${body.length}`
				: "";
		const footer = truncateToWidth(
			this.options.theme.fg("dim", `↑/↓ scroll · PgUp/PgDn page · Home/End · Esc/q close${position}`),
			safeWidth,
		);
		return [...header, ...slice.lines, footer];
	}

	private scrollTo(next: number): void {
		const clamped = clampOffset(next, this.bodyLength, this.bodyHeight());
		if (clamped === this.offset) return;
		this.offset = clamped;
		this.options.tui.requestRender();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.options.onClose();
			return;
		}
		let next: number | null = null;
		if (matchesKey(data, Key.up)) next = this.offset - 1;
		else if (matchesKey(data, Key.down)) next = this.offset + 1;
		else if (matchesKey(data, Key.pageUp)) next = this.offset - this.bodyHeight();
		else if (matchesKey(data, Key.pageDown)) next = this.offset + this.bodyHeight();
		else if (matchesKey(data, Key.home)) next = 0;
		else if (matchesKey(data, Key.end)) next = this.bodyLength;
		else {
			const wheel = parseWheelInput(data);
			if (wheel !== null) next = this.offset + wheel * WHEEL_STEP;
		}
		if (next !== null) this.scrollTo(next);
	}

	invalidate(): void {
		this.markdown = null;
	}
}
