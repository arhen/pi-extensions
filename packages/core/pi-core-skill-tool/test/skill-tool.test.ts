import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

// Use the installed SDK's real modern prompt builder, like pi's extension runner does.
const sdkEntry = (
	import.meta as unknown as { resolve(specifier: string): string }
).resolve("@earendil-works/pi-coding-agent");
const modern = (await import(
	new URL("./core/system-prompt.js", sdkEntry).href
)) as {
	buildSystemPrompt: (options: unknown) => string;
	normalizeBuildSystemPromptOptions: (input: unknown) => StructuredOptions;
};

interface SkillLike {
	name: string;
	description: string;
	filePath?: string;
	baseDir: string;
	disableModelInvocation: boolean;
}

interface StructuredOptions {
	skills: SkillLike[];
	sections: Record<string, string>;
	cwd: string;
	selectedTools: string[];
	forceSystemPrompt?: string;
}

interface RegisteredSkillTool {
	name: string;
	description: string;
	execute: (
		id: string,
		params: { name?: unknown },
		signal?: AbortSignal,
		onUpdate?: unknown,
		ctx?: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details: unknown;
	}>;
}

function skill(overrides: Partial<SkillLike> = {}): SkillLike {
	return {
		name: "probe",
		description: "Probe skill",
		filePath: "/tmp/probe/SKILL.md",
		baseDir: "/tmp/probe",
		disableModelInvocation: false,
		...overrides,
	};
}

async function loadExtension(): Promise<{
	handlers: Array<(event: unknown) => unknown>;
	tools: RegisteredSkillTool[];
}> {
	const handlers: Array<(event: unknown) => unknown> = [];
	const tools: RegisteredSkillTool[] = [];
	const api = {
		on: (name: string, handler: (event: unknown) => unknown) => {
			if (name === "before_agent_start") handlers.push(handler);
			return () => {};
		},
		registerTool: (tool: RegisteredSkillTool) => {
			tools.push(tool);
		},
	};
	await extension(api as unknown as ExtensionAPI);
	return { handlers, tools };
}

async function runHandler(
	handlers: Array<(event: unknown) => unknown>,
	event: unknown,
): Promise<{
	result: { systemPrompt?: string } | undefined;
	warnings: string[];
}> {
	const warnings: string[] = [];
	const warn = spyOn(console, "warn").mockImplementation(
		(...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		},
	);
	try {
		const result = (await handlers[0]?.(event)) as
			| { systemPrompt?: string }
			| undefined;
		return { result, warnings };
	} finally {
		warn.mockRestore();
	}
}

/** Emulates pi's modern runner: options are normalized copies and systemPrompt re-renders. */
function modernHost(raw: {
	cwd?: string;
	selectedTools?: string[];
	sections?: Record<string, string>;
	skills?: SkillLike[];
	forceSystemPrompt?: string;
}) {
	const options = modern.normalizeBuildSystemPromptOptions({
		cwd: "/work",
		selectedTools: ["read", "bash"],
		...raw,
	});
	const event: Record<string, unknown> = {
		type: "before_agent_start",
		prompt: "hi",
		systemPromptOptions: options,
	};
	Object.defineProperty(event, "systemPrompt", {
		enumerable: true,
		configurable: true,
		get: () => modern.buildSystemPrompt(options),
	});
	return { event, options };
}

const SKILL_LOAD_LINE = {
	read: "Use the read tool to load a skill's file when the task matches its description.",
	bash: "Use bash to load a skill's file when the task matches its description.",
} as const;

/** Frozen pi 0.84.2-style rendered catalog block. */
function legacyCatalogBlock(wording: "read" | "bash"): string {
	return [
		"The following skills provide specialized instructions for specific tasks.",
		SKILL_LOAD_LINE[wording],
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
		"  <skill>",
		"    <name>probe</name>",
		"    <description>Probe skill</description>",
		"    <location>/tmp/probe/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
	].join("\n");
}

function legacySnapshot(wording: "read" | "bash"): string {
	return [
		"Guidelines:",
		"- Be concise in your responses",
		"",
		legacyCatalogBlock(wording),
		"Current working directory: /work",
	].join("\n");
}

/** Emulates the legacy runner: prebuilt prompt string plus the resource loader's shared options. */
function legacyHost(prompt: string, skills: SkillLike[]) {
	const options = {
		cwd: "/work",
		selectedTools: ["read", "bash"],
		skills,
		sections: { skills: "keep-custom-section" },
	};
	return {
		type: "before_agent_start",
		prompt: "hi",
		systemPrompt: prompt,
		systemPromptOptions: options,
	};
}

function expectNoCatalog(text: string): void {
	expect(text).not.toContain("<available_skills>");
	expect(text).not.toContain("<skills>");
}

describe("structured prompt host (pi >= 0.99)", () => {
	test("clears the skills option, keeps unrelated sections, and never forces the prompt", async () => {
		const { handlers, tools } = await loadExtension();
		const { event, options } = modernHost({
			sections: { mode: "keep-mode", mcp_servers: "keep-mcp" },
			skills: [skill()],
		});
		expect(modern.buildSystemPrompt(options)).toContain("<available_skills>");

		const { result, warnings } = await runHandler(handlers, event);

		expect(result).toBeUndefined();
		expect(options.skills).toHaveLength(0);
		const final = modern.buildSystemPrompt(options);
		expectNoCatalog(final);
		expect(final).toContain("keep-mode");
		expect(final).toContain("keep-mcp");
		expect(warnings).toEqual([]);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.name).toBe("skill");
		expect(tools[0]?.description).toContain("<name>probe</name>");
	});

	test("removes a custom skills section override", async () => {
		const { handlers } = await loadExtension();
		const { event, options } = modernHost({
			sections: { mode: "keep-mode", skills: "custom-skills-section" },
			skills: [skill()],
		});
		expect(modern.buildSystemPrompt(options)).toContain(
			"custom-skills-section",
		);

		await runHandler(handlers, event);

		expect(options.sections.skills).toBeUndefined();
		const final = modern.buildSystemPrompt(options);
		expect(final).not.toContain("custom-skills-section");
		expect(final).toContain("keep-mode");
	});

	test("strips when only bash is available (bash wording)", async () => {
		const { handlers } = await loadExtension();
		const { event, options } = modernHost({
			selectedTools: ["bash"],
			skills: [skill()],
		});
		expect(modern.buildSystemPrompt(options)).toContain(SKILL_LOAD_LINE.bash);

		const { result, warnings } = await runHandler(handlers, event);

		expect(result).toBeUndefined();
		expectNoCatalog(modern.buildSystemPrompt(options));
		expect(warnings).toEqual([]);
	});

	test("strips when only read is available", async () => {
		const { handlers } = await loadExtension();
		const { event, options } = modernHost({
			selectedTools: ["read"],
			skills: [skill()],
		});
		expect(modern.buildSystemPrompt(options)).toContain(SKILL_LOAD_LINE.read);

		await runHandler(handlers, event);

		expectNoCatalog(modern.buildSystemPrompt(options));
	});

	test("selected tools without read/bash render no catalog and warn nothing", async () => {
		const { handlers, tools } = await loadExtension();
		const { event, options } = modernHost({
			selectedTools: ["edit", "write"],
			skills: [skill()],
		});
		expect(modern.buildSystemPrompt(options)).not.toContain(
			"<available_skills>",
		);

		const { result, warnings } = await runHandler(handlers, event);

		expect(result).toBeUndefined();
		expect(options.skills).toHaveLength(0);
		expect(warnings).toEqual([]);
		expect(tools).toHaveLength(1);
	});

	test("no discovered skills: no strip, no tool, no warning", async () => {
		const { handlers, tools } = await loadExtension();
		const { event } = modernHost({ skills: [] });

		const { result, warnings } = await runHandler(handlers, event);

		expect(result).toBeUndefined();
		expect(warnings).toEqual([]);
		expect(tools).toHaveLength(0);
	});

	test("warns only when the catalog actually survives (forced prompt)", async () => {
		const { handlers } = await loadExtension();
		const { event, options } = modernHost({
			skills: [skill()],
			forceSystemPrompt:
				"FORCED PROMPT\n<available_skills>\n</available_skills>",
		});

		const { result, warnings } = await runHandler(handlers, event);

		expect(result).toBeUndefined();
		expect(options.skills).toHaveLength(0);
		expect(warnings).toHaveLength(1);
	});

	test("repeated starts strip each fresh options copy and register the tool once", async () => {
		const { handlers, tools } = await loadExtension();
		const first = modernHost({ skills: [skill()] });
		const second = modernHost({ skills: [skill({ name: "other" })] });

		const firstRun = await runHandler(handlers, first.event);
		const secondRun = await runHandler(handlers, second.event);

		expect(firstRun.result).toBeUndefined();
		expect(secondRun.result).toBeUndefined();
		expect(firstRun.warnings).toEqual([]);
		expect(secondRun.warnings).toEqual([]);
		expect(first.options.skills).toHaveLength(0);
		expect(second.options.skills).toHaveLength(0);
		expectNoCatalog(modern.buildSystemPrompt(first.options));
		expectNoCatalog(modern.buildSystemPrompt(second.options));
		expect(tools).toHaveLength(1);
	});
});

describe("legacy prompt-string host (pi 0.84.x)", () => {
	test("strips the read-wording snapshot and leaves shared discovery untouched", async () => {
		const { handlers, tools } = await loadExtension();
		const shared = [skill()];
		const event = legacyHost(legacySnapshot("read"), shared);

		const { result, warnings } = await runHandler(handlers, event);

		expect(result?.systemPrompt).toBe(
			"Guidelines:\n- Be concise in your responses\nCurrent working directory: /work",
		);
		expect(shared).toHaveLength(1);
		expect(event.systemPromptOptions.skills).toBe(shared);
		expect(event.systemPromptOptions.sections.skills).toBe(
			"keep-custom-section",
		);
		expect(warnings).toEqual([]);
		expect(tools).toHaveLength(1);
	});

	test("strips the bash-wording snapshot", async () => {
		const { handlers } = await loadExtension();
		const shared = [skill()];
		const event = legacyHost(legacySnapshot("bash"), shared);

		const { result, warnings } = await runHandler(handlers, event);

		expect(result?.systemPrompt).toBe(
			"Guidelines:\n- Be concise in your responses\nCurrent working directory: /work",
		);
		expect(shared).toHaveLength(1);
		expect(warnings).toEqual([]);
	});

	test("removes a <skills> section wrapper emptied by the strip", async () => {
		const { handlers } = await loadExtension();
		const prompt = `KEEP-BEFORE\n\n<skills>\n${legacyCatalogBlock("bash")}\n</skills>\n\nKEEP-AFTER`;
		const event = legacyHost(prompt, [skill()]);

		const { result, warnings } = await runHandler(handlers, event);

		expect(result?.systemPrompt).toBe("KEEP-BEFORE\n\nKEEP-AFTER");
		expect(warnings).toEqual([]);
	});

	test("leaves an unrelated non-empty <skills> tag untouched", async () => {
		const { handlers } = await loadExtension();
		const prompt =
			"KEEP-BEFORE\n\n<skills>\nuser content\n</skills>\n\nKEEP-AFTER";
		const event = legacyHost(prompt, [skill()]);

		const { result, warnings } = await runHandler(handlers, event);

		expect(result).toBeUndefined();
		expect(event.systemPrompt).toBe(prompt);
		expect(warnings).toEqual([]);
	});

	test("warns and leaves the prompt when the catalog format is unknown", async () => {
		const { handlers } = await loadExtension();
		const shared = [skill()];
		const unknownCatalog = legacyCatalogBlock("read").replace(
			"The following skills provide specialized instructions for specific tasks.",
			"These skills are available.",
		);
		const prompt = `KEEP-BEFORE\n\n${unknownCatalog}\n\nKEEP-AFTER`;
		const event = legacyHost(prompt, shared);

		const { result, warnings } = await runHandler(handlers, event);

		expect(result).toBeUndefined();
		expect(event.systemPrompt).toBe(prompt);
		expect(shared).toHaveLength(1);
		expect(warnings).toHaveLength(1);
	});

	test("does not warn when discovered skills are not rendered in the prompt", async () => {
		const { handlers } = await loadExtension();
		const shared = [skill()];
		const event = legacyHost("plain prompt without any catalog", shared);

		const { result, warnings } = await runHandler(handlers, event);

		expect(result).toBeUndefined();
		expect(shared).toHaveLength(1);
		expect(warnings).toEqual([]);
	});
});

describe("skill tool", () => {
	test("loads skill bodies lazily without frontmatter and rejects hidden/unknown skills", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-skill-tool-"));
		try {
			const filePath = join(dir, "SKILL.md");
			writeFileSync(
				filePath,
				[
					"---",
					"name: probe",
					"description: Probe skill",
					"---",
					"",
					"# Body",
					"",
					"Follow these steps.",
				].join("\n"),
			);
			const { handlers, tools } = await loadExtension();
			const { event } = modernHost({
				skills: [
					skill({ filePath, baseDir: dir }),
					skill({
						name: "hidden",
						description: "Hidden skill",
						filePath,
						baseDir: dir,
						disableModelInvocation: true,
					}),
				],
			});

			await runHandler(handlers, event);
			const tool = tools[0];
			expect(tool).toBeDefined();
			expect(tool?.description).not.toContain("Hidden skill");

			const loaded = await tool?.execute("call-1", { name: "probe" });
			const text = loaded?.content[0]?.text ?? "";
			expect(text).toContain("## Skill: probe");
			expect(text).toContain(`**Base directory**: ${dir}`);
			expect(text).toContain("# Body");
			expect(text).toContain("Follow these steps.");
			expect(text).not.toContain("description: Probe skill");

			const hidden = await tool?.execute("call-2", { name: "hidden" });
			expect(hidden?.content[0]?.text).toContain('Skill "hidden" not found');
			const unknown = await tool?.execute("call-3", { name: "nope" });
			expect(unknown?.content[0]?.text).toContain('Skill "nope" not found');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("PI_SKILL_TOOL=0 still strips the catalog but registers no tool", async () => {
		const previous = process.env.PI_SKILL_TOOL;
		process.env.PI_SKILL_TOOL = "0";
		try {
			const { handlers, tools } = await loadExtension();
			const { event, options } = modernHost({ skills: [skill()] });

			const { result, warnings } = await runHandler(handlers, event);

			expect(result).toBeUndefined();
			expect(options.skills).toHaveLength(0);
			expectNoCatalog(modern.buildSystemPrompt(options));
			expect(tools).toHaveLength(0);
			expect(warnings).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.PI_SKILL_TOOL;
			else process.env.PI_SKILL_TOOL = previous;
		}
	});
});
