/**
 * pi-skill-tool — opencode2-style skills for pi.
 *
 * Strips the built-in <available_skills> catalog from the system prompt
 * (~7.2K tokens) and exposes skills through a single `skill` tool.
 * The agent still auto-invokes skills by calling the tool — no user input.
 *
 * The catalog comes from pi's own discovery (event.systemPromptOptions.skills):
 * project, user, settings, CLI, and package skills are all covered — no
 * re-scanning, no divergence.
 *
 * Compatibility: pi >= 0.99 renders the prompt on every read from mutable,
 * normalized `systemPromptOptions`, so the extension removes the `skills` entry
 * there and never returns `systemPrompt` (a forced prompt would stop pi's
 * per-section delta updates). Older pi builds pass a prebuilt prompt string
 * plus the resource loader's shared options, so only the rendered catalog text
 * is stripped and the shared skill list is left untouched for `/skill:name`.
 */

import { parseFrontmatter, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Type } from "typebox";

const CATALOG_DESC_MAX = 100;
const CATALOG_TAG = "<available_skills>";

/**
 * Rendered legacy catalog: `read` wording on old pi builds, `bash` wording when
 * only the bash tool can read skill files. Ends at the closing catalog tag so
 * surrounding prompt text is preserved.
 */
const RENDERED_CATALOG =
	/\n*The following skills provide specialized instructions for specific tasks\.\nUse (?:the read tool|bash) to load a skill's file when the task matches its description\.[\s\S]*?<\/available_skills>/;

/** `<skills>` section left empty after the catalog block was removed. */
const EMPTY_SKILLS_SECTION = /<skills>\n\s*<\/skills>\n*/;

interface SkillEntry {
	name: string;
	description: string;
	filePath?: string;
	baseDir: string;
	disableModelInvocation: boolean;
}

/** Prompt options after pi's normalization (>= 0.99). */
interface StructuredPromptOptions {
	skills?: unknown[];
	sections?: Record<string, unknown>;
}

function truncateDescription(desc: string): string {
	if (desc.length <= CATALOG_DESC_MAX) return desc;
	return desc.slice(0, CATALOG_DESC_MAX).trimEnd() + "…";
}

function readSkillBody(filePath: string): string {
	try {
		const content = readFileSync(filePath, "utf8");
		const { body } = parseFrontmatter<Record<string, unknown>>(content);
		return body.trim(); // L1: never leak frontmatter to the model
	} catch (err) {
		return `Skill file unreadable: ${filePath} (${err instanceof Error ? err.message : String(err)})`;
	}
}

/**
 * pi >= 0.99 exposes `systemPrompt` as an accessor that re-renders from the
 * normalized options; the older runner passes a prebuilt string and the
 * resource loader's shared options object. Only the accessor host owns a private
 * copy of `skills`/`sections`, so only there may the catalog be removed.
 */
function isStructuredPromptHost(event: object): boolean {
	const descriptor = Object.getOwnPropertyDescriptor(event, "systemPrompt");
	return typeof descriptor?.get === "function";
}

function clearStructuredSkillCatalog(options: StructuredPromptOptions): void {
	try {
		if (Array.isArray(options.skills)) options.skills.length = 0;
		if (options.sections !== undefined && options.sections !== null) delete options.sections.skills;
	} catch {
		// Frozen options: leave the catalog in place and warn from the caller.
	}
}

function stripRenderedSkillCatalog(prompt: string): string {
	return prompt.replace(RENDERED_CATALOG, "").replace(EMPTY_SKILLS_SECTION, "");
}

function warnCatalogRemains(): void {
	console.warn(
		"[pi-core-skill-tool] strip failed — the skills catalog is still in the system prompt; pi's prompt format may have changed",
	);
}

export default async function (pi: ExtensionAPI) {
	let catalog: SkillEntry[] = [];
	let toolRegistered = false;

	// ── Strip built-in catalog from system prompt (intro + block) ──────────
	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions as unknown as StructuredPromptOptions;
		const skills = (options.skills ?? []) as SkillEntry[];
		if (skills.length === 0) return; // no catalog → nothing to strip
		// Copy the catalog before any removal: the tool description needs it.
		catalog = skills.map((s) => ({
			name: s.name,
			description: s.description,
			filePath: s.filePath,
			baseDir: s.baseDir,
			disableModelInvocation: s.disableModelInvocation,
		}));

		if (isStructuredPromptHost(event)) {
			clearStructuredSkillCatalog(options);
			if (event.systemPrompt.includes(CATALOG_TAG)) warnCatalogRemains();
			registerToolOnce();
			// Returning systemPrompt here would set forceSystemPrompt and disable
			// pi's section-delta updates; the cleared options already render clean.
			return undefined;
		}

		// Legacy host: strip the rendered catalog and return the text for this run.
		const stripped = stripRenderedSkillCatalog(event.systemPrompt);
		if (stripped !== event.systemPrompt) {
			if (stripped.includes(CATALOG_TAG)) warnCatalogRemains();
			registerToolOnce();
			return { systemPrompt: stripped };
		}
		if (event.systemPrompt.includes(CATALOG_TAG)) warnCatalogRemains();
		registerToolOnce();
		return undefined;
	});

	// H1: the tool's description must carry the populated catalog, so register
	// lazily on the FIRST agent start (registration snapshots the description).
	function registerToolOnce() {
		if (toolRegistered || process.env.PI_SKILL_TOOL === "0") return;
		toolRegistered = true;
		registerSkillTool();
	}

	// ── Register skill tool (opencode2-style) ────────────────────────────────
	// Set PI_SKILL_TOOL=0 to disable the tool (catalog stripped, no tool —
	// skills only usable via pi's built-in /skill:name commands).
	function registerSkillTool() {
		pi.registerTool({
			name: "skill",
			label: "Skill",
			description: [
				"Load a skill to get detailed instructions for a specific task.",
				"Skills provide specialized knowledge and step-by-step guidance.",
				"Use this when a task matches an available skill's description.",
				"Only the skills listed here are available:",
				"<available_skills>",
				...catalog
					.filter((s) => !s.disableModelInvocation)
					.map(
						(s) =>
							`  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(truncateDescription(s.description))}</description>\n  </skill>`,
					),
				"</available_skills>",
			].join("\n"),
			parameters: Type.Object({
				name: Type.String({ description: "The skill identifier from available_skills" }),
			}),
			async execute(_toolCallId: string, params: { name?: unknown }, _signal: AbortSignal | undefined, _onUpdate: AgentToolUpdateCallback<unknown> | undefined, _ctx: ExtensionContext): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
				const name = typeof params.name === "string" ? params.name : "";
				const skill = catalog.find((s) => !s.disableModelInvocation && s.name === name);
				if (!skill) {
					return {
						content: [
							{
								type: "text",
								text: `Skill "${name}" not found. Available skills: ${catalog.filter((s) => !s.disableModelInvocation).map((s) => s.name).join(", ") || "(none)"}`,
							},
						],
						details: {},
					};
				}
				if (!skill.filePath) {
					return {
						content: [
							{
								type: "text",
								text: `Skill "${skill.name}" has no loadable file path in this context.`,
							},
						],
						details: {},
					};
				}
				const body = readSkillBody(skill.filePath);
				const dir = skill.baseDir;
				return {
					content: [
						{
							type: "text",
							text: `## Skill: ${skill.name}\n\n**Base directory**: ${dir}\n\n${body}`,
						},
					],
					details: {},
				};
			},
		});
	}
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
