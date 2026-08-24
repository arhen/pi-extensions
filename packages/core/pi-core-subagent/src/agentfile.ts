/** Agent-file resolution — matched by description (goal), not by name.
 *  The model names a subagent with a goal (name + task); user agent files in
 *  `.agents/agents`, `.claude/agents`, `.pi/agents` are scored by token overlap
 *  between their `description` frontmatter and that goal. Best match wins;
 *  ties break by directory priority. A matched file is authoritative (file wins
 *  over inline prompt/model/tools). No match → inline on-demand definition. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentFileInfo {
	body: string;
	model?: string;
	tools?: string[];
	description?: string;
	/** The matched file path — surfaced so the leader can audit which file won. */
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
]);

/** A body becomes the child's ENTIRE system prompt — an oversized reference file
 *  would blow the context window and kill the session with a cryptic error. */
const MAX_BODY_CHARS = 64_000;

/** Per-cwd memo of the ancestor walk (project dirs then home), since the files
 *  can't meaningfully change within one run and the walk costs 3 sync stats per
 *  ancestor dir per task otherwise. Keyed per (agentDir + cwd). */
const walkCache = new Map<string, AgentFileInfo[]>();

/** Test/diagnostic hook: flush the walk cache (files changed mid-session). */
export function clearAgentFileCache(): void {
	walkCache.clear();
}

/** Lowercase, split, drop stopwords, strip plural -s/-es. */
function tokens(text: string): string[] {
	return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
		.filter((t) => !STOP.has(t) && t.length > 1)
		.map((t) => {
			if (t.endsWith("ing") && t.length > 5) t = t.slice(0, -3);
			if (t.endsWith("es") && t.length > 4) t = t.slice(0, -2);
			else if (t.endsWith("s") && t.length > 3) t = t.slice(0, -1);
			return t;
		});
}

function score(query: string[], desc: string[]): number {
	let shared = 0;
	for (const t of query) if (desc.includes(t)) shared += 1;
	return shared >= 2 ? shared : 0;
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

/** Walk cwd's ancestors, then home, returning files in priority order (nearest
 *  first, each dir's 3 subdirs in AGENT_DIRS order). */
function allAgentFiles(cwd: string, agentDir: string): AgentFileInfo[] {
	const out: AgentFileInfo[] = [];
	let dir = cwd;
	while (true) {
		for (const sub of AGENT_DIRS) out.push(...readAgentFile(join(dir, sub)));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const home = dirname(dirname(agentDir)); // ~/.pi/agent → ~
	for (const sub of AGENT_DIRS) out.push(...readAgentFile(join(home, sub)));
	return out;
}

/** Best agent-file match for a spawn goal. Caches per (agentDir, cwd). */
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
