/** Named agent-file resolution (.agents/.claude/.pi agents dirs). */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentFileInfo {
	body: string;
	model?: string;
	tools?: string[];
}

const AGENT_DIRS = [".agents/agents", ".claude/agents", ".pi/agents"] as const;
/** Agent names become file paths — refuse anything that could traverse. */
const SAFE_NAME = /^[\w.-]+$/;

function readAgentFile(dir: string, name: string): AgentFileInfo | undefined {
	if (!existsSync(dir)) return undefined;
	const path = join(dir, `${name}.md`);
	if (!existsSync(path)) return undefined;
	const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));
	const tools =
		typeof frontmatter.tools === "string"
			? frontmatter.tools
					.split(",")
					.map((t) => t.trim())
					.filter(Boolean)
			: Array.isArray(frontmatter.tools)
				? frontmatter.tools.map(String)
				: undefined;
	return {
		body,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		tools: tools?.length ? tools : undefined,
	};
}

/**
 * Look up `<name>.md` in agent dirs. Order: for each ancestor of `cwd` (nearest
 * first): `.agents/agents` (single source per the ~/.agents spec) → `.claude/agents`
 * → `.pi/agents`; then home: `~/.agents/agents` → `~/.claude/agents` → `~/.pi/agents`.
 * First match wins. `agentDir` is the pi agent dir (`~/.pi/agent`); home is derived from it.
 */
export function resolveAgentFile(name: string, cwd: string, agentDir: string): AgentFileInfo | undefined {
	if (!SAFE_NAME.test(name)) return undefined;
	let dir = cwd;
	while (true) {
		for (const sub of AGENT_DIRS) {
			const hit = readAgentFile(join(dir, sub), name);
			if (hit) return hit;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const home = dirname(dirname(agentDir)); // ~/.pi/agent → ~
	for (const sub of AGENT_DIRS) {
		const hit = readAgentFile(join(home, sub), name);
		if (hit) return hit;
	}
	return undefined;
}
