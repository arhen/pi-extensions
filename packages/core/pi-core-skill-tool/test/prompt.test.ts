/**
 * Regression tests for the structured system-prompt skills section (pi 1.0.1).
 *
 * The previous implementation removed the catalog with a regex over the rendered
 * prompt. Pi wraps the catalog in a `<skills>` section, so the regex stopped
 * matching and the handler fell back to forcing an opaque `systemPrompt` that
 * still contained the catalog. These tests drive the handler through pi's real
 * `buildSystemPrompt` and assert the catalog disappears from the structured
 * options instead. Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillToolExtension from "../src/index.ts";

interface PiSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: unknown;
	disableModelInvocation: boolean;
}

interface PromptOptions {
	cwd: string;
	skills: PiSkill[];
	[key: string]: unknown;
}

interface SystemPromptModule {
	normalizeBuildSystemPromptOptions: (input: unknown) => PromptOptions;
	buildSystemPrompt: (options: unknown) => string;
}

interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	systemPromptOptions: PromptOptions;
	readonly systemPrompt: string;
}

type BeforeAgentStartHandler = (event: BeforeAgentStartEvent) => unknown;

interface CapturedTool {
	name: string;
	description: string;
	execute: (
		toolCallId: string,
		params: { name?: unknown },
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

// pi does not export its prompt builder publicly; tests import the installed
// build so the assertions track the real renderer instead of a fixture.
const PI_ENTRY = import.meta.resolve("@earendil-works/pi-coding-agent");
const { buildSystemPrompt, normalizeBuildSystemPromptOptions } = (await import(
	new URL("./core/system-prompt.js", PI_ENTRY).href
)) as unknown as SystemPromptModule;

delete process.env.PI_SKILL_TOOL;

function createPiStub() {
	const handlers = new Map<string, BeforeAgentStartHandler[]>();
	const tools: CapturedTool[] = [];
	const pi = {
		on: (event: string, handler: BeforeAgentStartHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: (tool: CapturedTool) => {
			tools.push(tool);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, tools };
}

function makeSkill(name: string, overrides: Partial<PiSkill> = {}): PiSkill {
	return {
		name,
		description: `${name} skill description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { source: "test", path: `/skills/${name}/SKILL.md` },
		disableModelInvocation: false,
		...overrides,
	};
}

function startEvent(options: PromptOptions): BeforeAgentStartEvent {
	return {
		type: "before_agent_start",
		prompt: "hi",
		systemPromptOptions: options,
		get systemPrompt() {
			return buildSystemPrompt(options);
		},
	};
}

async function startWith(skills: PiSkill[]) {
	const { pi, handlers, tools } = createPiStub();
	await skillToolExtension(pi);
	const handler = handlers.get("before_agent_start")?.[0];
	if (!handler) throw new Error("extension did not register a before_agent_start handler");
	const options = normalizeBuildSystemPromptOptions({ cwd: "/tmp/project", skills });
	const event = startEvent(options);
	const before = buildSystemPrompt(options);
	const result = await handler(event);
	return { result, event, options, tools, before };
}

describe("structured skills prompt", () => {
	test("drops the skills section via systemPromptOptions without forcing a prompt", async () => {
		const { result, event, options, before } = await startWith([makeSkill("caveman"), makeSkill("hidden", { disableModelInvocation: true })]);

		// Precondition: pi renders the catalog as a tagged `<skills>` section.
		expect(before).toContain("<skills>");
		expect(before).toContain("<available_skills>");

		// A forced `systemPrompt` would make the run opaque; the structured option is the fix.
		expect(result).toBeUndefined();
		expect(options.skills).toEqual([]);

		const after = buildSystemPrompt(options);
		expect(after).not.toContain("<skills>");
		expect(after).not.toContain("<available_skills>");
		expect(after).not.toContain("The following skills provide specialized instructions");
		expect(event.systemPrompt).not.toContain("<available_skills>");
		// The rest of the prompt survives.
		expect(after).toContain("<cwd>");
		expect(after).toContain("You are an expert coding assistant");
	});

	test("registers one populated skill tool, excluding disable-model-invocation skills", async () => {
		const { tools } = await startWith([makeSkill("caveman"), makeSkill("hidden", { disableModelInvocation: true })]);

		expect(tools.map((tool) => tool.name)).toEqual(["skill"]);
		const tool = tools[0]!;
		expect(tool.description).toContain("<available_skills>");
		expect(tool.description).toContain("caveman");
		expect(tool.description).not.toContain("hidden");
	});

	test("returns the SKILL.md body without frontmatter when called", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-skill-tool-"));
		const filePath = join(dir, "SKILL.md");
		writeFileSync(filePath, "---\nname: tmp\ndescription: tmp skill\n---\n\nBody line\n");
		const { tools } = await startWith([makeSkill("tmp", { filePath, baseDir: dir })]);

		const result = await tools[0]!.execute("call-1", { name: "tmp" }, undefined, undefined, undefined);
		expect(result.content[0]?.text).toContain("## Skill: tmp");
		expect(result.content[0]?.text).toContain("Body line");
		expect(result.content[0]?.text).not.toContain("name: tmp");
	});

	test("reports an unknown skill with the available names", async () => {
		const { tools } = await startWith([makeSkill("caveman")]);

		const result = await tools[0]!.execute("call-1", { name: "nope" }, undefined, undefined, undefined);
		expect(result.content[0]?.text).toContain('Skill "nope" not found');
		expect(result.content[0]?.text).toContain("caveman");
	});
});
