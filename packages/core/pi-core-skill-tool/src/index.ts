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
 */

import { parseFrontmatter, type AgentToolUpdateCallback, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Type } from "typebox";

const CATALOG_DESC_MAX = 100;

interface SkillEntry {
	name: string;
	description: string;
	filePath?: string;
	baseDir: string;
	disableModelInvocation: boolean;
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

export default async function (pi: ExtensionAPI) {
	let catalog: SkillEntry[] = [];
	let toolRegistered = false;

	// ── Strip built-in catalog from system prompt (intro + block) ──────────
	pi.on("before_agent_start", (event) => {
		const skills = event.systemPromptOptions.skills ?? [];
		if (skills.length === 0) return; // no catalog → nothing to strip
		catalog = skills.map((s) => ({
			name: s.name,
			description: s.description,
			filePath: s.filePath,
			baseDir: s.baseDir,
			disableModelInvocation: s.disableModelInvocation,
		}));
		const stripped = event.systemPrompt.replace(
			/\n\nThe following skills provide specialized instructions for specific tasks\.\nUse the read tool to load a skill's file[\s\S]*<\/available_skills>\n?/,
			"",
		);
		if (stripped === event.systemPrompt) {
			console.warn("[pi-core-skill-tool] strip failed — pi's skills prompt format changed; catalog left intact");
		}
		// H1: the tool's description must carry the populated catalog, so register
		// lazily on the FIRST agent start (registration snapshots the description).
		if (!toolRegistered && process.env.PI_SKILL_TOOL !== "0") {
			toolRegistered = true;
			registerSkillTool();
		}
		return { systemPrompt: stripped };
	});

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
