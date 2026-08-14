/**
 * pi-skill-tool — opencode2-style skills for pi.
 *
 * Strips the built-in <available_skills> catalog from the system prompt
 * (~7.2K tokens) and instead exposes skills through a single `skill` tool.
 * The agent still auto-invokes skills by calling the tool — no user input.
 *
 * Install: copy to ~/.pi/agent/extensions/pi-skill-tool/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CATALOG_DESC_MAX = 100; // truncate catalog descriptions to keep tool schema lean

function truncateDescription(desc: string): string {
	if (desc.length <= CATALOG_DESC_MAX) return desc;
	return desc.slice(0, CATALOG_DESC_MAX).trimEnd() + "…";
}

// =============================================================================
// Skill discovery (mirrors pi's locations: ~/.pi/agent/skills, ~/.agents/skills,
// npm package skills). Dedupes symlinks via realpath.
// =============================================================================

const AGENT_DIR = join(homedir(), ".pi", "agent");
const NPM_DIR = join(AGENT_DIR, "npm", "node_modules");

interface SkillInfo {
	name: string;
	description: string;
	filePath: string;
}

function scanDirForSkills(dir: string, out: Map<string, SkillInfo>) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const skillDir = join(dir, entry.name);
		const mdPath = join(skillDir, "SKILL.md");
		if (!existsSync(mdPath)) continue;
		try {
			const real = realpathSync(mdPath);
			if (out.has(real)) continue; // dedupe symlinked skills
			const parsed = parseSkill(mdPath);
			if (parsed) out.set(real, parsed);
		} catch {
			// unreadable skill — skip
		}
	}
}

function parseSkill(mdPath: string): SkillInfo | null {
	const content = readFileSync(mdPath, "utf8");
	const m = content.match(/^---\n([\s\S]*?)\n---/);
	if (!m) return null;
	const fm = m[1];
	const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
	const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
	if (!name || !description) return null;
	return { name, description, filePath: mdPath };
}

function loadSkills(): Map<string, SkillInfo> {
	const out = new Map<string, SkillInfo>();
	scanDirForSkills(join(AGENT_DIR, "skills"), out);
	scanDirForSkills(join(homedir(), ".agents", "skills"), out);
	// npm package skills: node_modules/<pkg>/skills/*/SKILL.md and scoped
	for (const scope of [NPM_DIR]) {
		if (!existsSync(scope)) continue;
		for (const entry of readdirSync(scope, { withFileTypes: true })) {
			const base =
				entry.isDirectory() && entry.name.startsWith("@")
					? join(scope, entry.name)
					: scope;
			const pkgDir =
				entry.isDirectory() && entry.name.startsWith("@")
					? null
					: join(scope, entry.name);
			if (pkgDir) {
				scanDirForSkills(join(pkgDir, "skills"), out);
			} else {
				for (const sub of readdirSync(base, { withFileTypes: true })) {
					if (sub.isDirectory()) {
						scanDirForSkills(join(base, sub.name, "skills"), out);
					}
				}
			}
		}
	}
	return out;
}

function readSkillBody(filePath: string): string {
	const content = readFileSync(filePath, "utf8");
	const m = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
	return m ? m[1].trim() : content;
}

// =============================================================================
// Extension
// =============================================================================

export default async function (pi: ExtensionAPI) {
	const skills = loadSkills();
	const visible = [...skills.values()];

	// ── Strip built-in catalog from system prompt ───────────────────────────
	pi.on("before_agent_start", (event) => {
		if (!event.systemPrompt.includes("<available_skills>")) return;
		const stripped = event.systemPrompt.replace(
			/<available_skills>[\s\S]*?<\/available_skills>/,
			"",
		);
		return { systemPrompt: stripped };
	});

	// ── Register skill tool (opencode2-style) ────────────────────────────────
	pi.registerTool({
		name: "skill",
		label: "Skill",
		description: [
			"Load a skill to get detailed instructions for a specific task.",
			"Skills provide specialized knowledge and step-by-step guidance.",
			"Use this when a task matches an available skill's description.",
			"Only the skills listed here are available:",
			"<available_skills>",
			...visible.map(
				(s) =>
					`  <skill>\n    <name>${s.name}</name>\n    <description>${escapeXml(truncateDescription(s.description))}</description>\n  </skill>`,
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
			const skill = [...skills.values()].find((s) => s.name === params.name);
			if (!skill) {
				return {
					content: [
						{
							type: "text",
							text: `Skill "${params.name}" not found. Available skills: ${[...skills.values()].map((s) => s.name).join(", ")}`,
						},
					],
					details: { ok: false },
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
				details: { ok: true },
			};
		},
	});
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
