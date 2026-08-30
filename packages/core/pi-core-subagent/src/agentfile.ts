import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentFileInfo {
	body: string;
	model?: string;
	tools?: string[];
	description?: string;
	path?: string;
}

const AGENT_DIRS = [".agents/agents", ".claude/agents", ".pi/agents"] as const;
const STOP = new Set([
	"the",
	"a",
	"an",
	"of",
	"for",
	"and",
	"or",
	"to",
	"in",
	"on",
	"with",
	"by",
	"at",
	"during",
	"your",
	"you",
	"their",
	"its",
	"is",
	"are",
	"be",
	"as",
	"how",
	"what",
	"who",

	"from",
	"into",
	"this",
	"that",
	"it",
	"all",
	"any",
	"per",
	"via",
	"other",
]);

const MAX_BODY_CHARS = 64_000;
const MIN_SHARED_TERMS = 2;
const MIN_COVERAGE = 0.4;

const walkCache = new Map<string, AgentFileInfo[]>();

export function clearAgentFileCache(): void {
	walkCache.clear();
}

function tokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
		.filter((t) => !STOP.has(t) && t.length > 1)
		.map((t) => {
			if (t.endsWith("ing") && t.length > 5) t = t.slice(0, -3);

			if (/(?:ch|sh|ss|x|z|s)es$/.test(t) && t.length > 4) t = t.slice(0, -2);
			else if (t.endsWith("s") && !t.endsWith("ss") && t.length > 3) t = t.slice(0, -1);
			return t;
		});
}

function score(query: string[], desc: string[]): number {
	if (desc.length === 0) return 0;
	const q = new Set(query);
	const shared = new Set<string>();
	for (const t of desc) if (q.has(t)) shared.add(t);
	if (shared.size < MIN_SHARED_TERMS) return 0;

	const denom = Math.min(new Set(desc).size, q.size);
	if (denom === 0 || shared.size / denom < MIN_COVERAGE) return 0;
	return shared.size;
}

function readAgentFile(dir: string): AgentFileInfo[] {
	if (!existsSync(dir)) return [];
	const out: AgentFileInfo[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(".md")) continue;
		const path = join(dir, entry);
		const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
		let trimmed = body;
		if (trimmed.length > MAX_BODY_CHARS) {
			trimmed = `${trimmed.slice(0, MAX_BODY_CHARS)}\n\n[truncated: agent file exceeded ${MAX_BODY_CHARS} chars — slim it down]`;
		}
		const toolsF = frontmatter.tools;
		const tools =
			typeof toolsF === "string"
				? toolsF
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: Array.isArray(toolsF)
					? toolsF.map(String)
					: undefined;
		out.push({
			body: trimmed,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			tools: tools?.length ? tools : undefined,
			description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
			path,
		});
	}
	return out;
}

function allAgentFiles(cwd: string, agentDir: string): AgentFileInfo[] {
	const out: AgentFileInfo[] = [];
	let dir = cwd;
	while (true) {
		for (const sub of AGENT_DIRS) out.push(...readAgentFile(join(dir, sub)));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const home = dirname(dirname(agentDir));
	for (const sub of AGENT_DIRS) out.push(...readAgentFile(join(home, sub)));
	return out;
}

export function resolveAgentFile(name: string, task: string, cwd: string, agentDir: string): AgentFileInfo | undefined {
	const query = tokens(`${name} ${task}`);
	const cacheKey = `${agentDir}${cwd}`;
	let files = walkCache.get(cacheKey);
	if (!files) {
		files = allAgentFiles(cwd, agentDir);
		if (walkCache.size >= 512) walkCache.clear();
		walkCache.set(cacheKey, files);
	}
	let best: AgentFileInfo | undefined;
	let bestScore = 0;
	for (const file of files) {
		const s = score(query, tokens(file.description ?? ""));
		if (s > 0 && s > bestScore) {
			best = file;
			bestScore = s;
		}
	}
	return best;
}
