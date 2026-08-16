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

import { parseFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

const CATALOG_DESC_MAX = 100;

interface SkillEntry {
	name: string;
	description: string;
	filePath?: string;
	disableModelInvocation: boolean;
}

function truncateDescription(desc: string): string {
	if (desc.length <= CATALOG_DESC_MAX) return desc;
	return desc.slice(0, CATALOG_DESC_MAX).trimEnd() + "…";
}

function readSkillBody(filePath: string): string {
	const content = readFileSync(filePath, "utf8");
	const { body } = parseFrontmatter<Record<string, unknown>>(content);
	return body.trim() || content;
}

export default async function (pi: ExtensionAPI) {
	let catalog: SkillEntry[] = [];

	// ── Strip built-in catalog from system prompt (intro + block) ──────────
	pi.on("before_agent_start", (event) => {
		catalog = (event.systemPromptOptions.skills ?? []).map((s) => ({
			name: s.name,
			description: s.description,
			filePath: s.filePath,
			disableModelInvocation: s.disableModelInvocation,
		}));
		if (!event.systemPromptOptions.skills) return; // no catalog → nothing to strip
		const stripped = event.systemPrompt.replace(
			/\n\nThe following skills provide specialized instructions for specific tasks\.\nUse the read tool to load a skill's file[\s\S]*?<\/available_skills>\n?/,
			"",
		);
		return { systemPrompt: stripped };
	});

	// ── Register skill tool (opencode2-style) ────────────────────────────────
	// Set PI_SKILL_TOOL=0 to disable the tool (catalog stripped, no tool —
	// skills only usable via pi's built-in /skill:name commands).
	if (process.env.PI_SKILL_TOOL !== "0") {
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
			parameters: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "The skill identifier from available_skills",
					},
				},
				required: ["name"],
			},
			async execute(_toolCallId, params: { name: string }) {
				const skill = catalog.find((s) => !s.disableModelInvocation && s.name === params.name);
				if (!skill) {
					return {
						content: [
							{
								type: "text",
								text: `Skill "${name}" not found. Available skills: ${catalog.filter((s) => !s.disableModelInvocation).map((s) => s.name).join(", ") || "(none)"}`,
							},
						],
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
					};
				}
				const body = readSkillBody(skill.filePath);
				const dir = skill.filePath.slice(0, -"SKILL.md".length);
				return {
					content: [
						{
							type: "text",
							text: `## Skill: ${skill.name}\n\n**Base directory**: ${dir}\n\n${body}`,
						},
					],
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
