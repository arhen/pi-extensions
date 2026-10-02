import type { Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, getTerminalColorMode, parseColor } from "@earendil-works/pi-tui";
import { COLOR_PALETTE } from "./types.ts";

const HEX_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RESET_FG = "\x1b[39m";

export function isHexColor(value: string): boolean {
	return HEX_PATTERN.test(value.trim());
}

/** Apply a mode colour (theme token or hex) to a string; unknown colours fall back to plain text. */
export function colorize(text: string, color: string | undefined, theme: Theme): string {
	const trimmed = color?.trim();
	if (!trimmed) return text;
	if (isHexColor(trimmed)) {
		try {
			return `${foregroundAnsi(parseColor(trimmed), getTerminalColorMode())}${text}${RESET_FG}`;
		} catch {
			return text;
		}
	}
	try {
		return theme.fg(trimmed as Parameters<Theme["fg"]>[0], text);
	} catch {
		return text;
	}
}

export function colorLabel(value: string | undefined): string {
	if (!value) return "(none)";
	return COLOR_PALETTE.find((entry) => entry.value === value)?.name ?? value;
}
