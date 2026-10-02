export const DEFAULT_MODE_NAME = "default";
export const STATE_ENTRY_TYPE = "pi-mode-state";
export const WIDGET_KEY = "pi-mode-standby";

export type ToolPreset = "default" | "plan" | "build";
export type ModeTools = ToolPreset | string[];

export interface Mode {
	name: string;
	enabled: boolean;
	color?: string;
	description?: string;
	instructions?: string;
	tools: ModeTools;
	model?: string;
	subagentModel?: string;
}

export interface ModeFileEntry {
	enabled?: unknown;
	color?: unknown;
	description?: unknown;
	instructions?: unknown;
	tools?: unknown;
	model?: unknown;
	subagentModel?: unknown;
}

export const TOOL_PRESETS: readonly ToolPreset[] = ["default", "plan", "build"];
export const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];
export const BUILD_TOOLS = ["read", "bash", "edit", "write"];
export const MANAGED_TOOLS = [...new Set([...READ_ONLY_TOOLS, ...BUILD_TOOLS])];
export const WRITE_TOOLS = new Set(["edit", "write"]);

export interface PaletteColor {
	name: string;
	value: string;
}

export const COLOR_PALETTE: readonly PaletteColor[] = [
	{ name: "theme accent", value: "accent" },
	{ name: "theme warning", value: "warning" },
	{ name: "theme success", value: "success" },
	{ name: "theme error", value: "error" },
	{ name: "orange", value: "#ff9f43" },
	{ name: "amber", value: "#f7b731" },
	{ name: "lime", value: "#a3e635" },
	{ name: "green", value: "#4ade80" },
	{ name: "teal", value: "#2dd4bf" },
	{ name: "cyan", value: "#22d3ee" },
	{ name: "blue", value: "#60a5fa" },
	{ name: "violet", value: "#a78bfa" },
	{ name: "magenta", value: "#e879f9" },
	{ name: "pink", value: "#fb7185" },
	{ name: "slate", value: "#94a3b8" },
];
