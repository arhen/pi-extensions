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
	"when",
	"who",
]);

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
		const { frontmatter, body } = parseFrontmatter(readFileSync(join(dir, entry), "utf8"));
		const tools =
			typeof frontmatter.tools === "string"
				? frontmatter.tools
						.split(",")
						.map((t) => t.trim())
						.filter(Boolean)
				: Array.isArray(frontmatter.tools)
					? frontmatter.tools.map(String)
					: undefined;
		out.push({
			body,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			tools: tools?.length ? tools : undefined,
			description: typeof frontmatter.description === "string" ? frontmatter.description : undefined,
		});
	}
	return out;
}

/**
 * Best agent-file match for a spawn goal. Order: `.agents/agents` (single
 * source) → `.claude/agents` → `.pi/agents` per cwd ancestor (nearest first),
 * then home (`~/.agents` → `~/.claude` → `~/.pi`). Within a dir, highest
 * description-overlap score wins; the first dir with a match is returned.
 * `agentDir` is the pi agent dir (`~/.pi/agent`); home is derived from it.
 */
export function resolveAgentFile(name: string, task: string, cwd: string, agentDir: string): AgentFileInfo | undefined {
	const query = tokens(`${name} ${task}`);
	let dir = cwd;
	while (true) {
		for (const sub of AGENT_DIRS) {
			let best: AgentFileInfo | undefined;
			let bestScore = 0;
			for (const file of readAgentFile(join(dir, sub))) {
				const s = score(query, tokens(file.description ?? ""));
				if (s > bestScore) {
					best = file;
					bestScore = s;
				}
			}
			if (best) return best; // first dir with any match wins (priority over score)
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const home = dirname(dirname(agentDir)); // ~/.pi/agent → ~
	for (const sub of AGENT_DIRS) {
		let best: AgentFileInfo | undefined;
		let bestScore = 0;
		for (const file of readAgentFile(join(home, sub))) {
			const s = score(query, tokens(file.description ?? ""));
			if (s > bestScore) {
				best = file;
				bestScore = s;
			}
		}
		if (best) return best;
	}
	return undefined;
}
