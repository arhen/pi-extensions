/** Spawn-cost bench: replicate manager.runChild's pipeline, phase by phase.
 *  Phase 1-4: no LLM. Phase 5: one real end-to-end spawn (cheap model).
 *  Run: bun bench/spawn-cost.ts */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolveAgentFile } from "../src/agentfile.ts";

const CWD = "/Users/alva-arhen/Code/personal/pi-extensions";
const AGENT_DIR = getAgentDir();
const MODEL = "my-google/gemma-4-31b-it"; // cheap, no reasoning
const RUNS = 3;

async function phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now();
	const r = await fn();
	console.log(`  ${name.padEnd(38)} ${(performance.now() - t0).toFixed(1)}ms`);
	return r;
}

// Phase 0: agent-file resolution cost (inline vs existing file)
const tmp = mkdtempSync(join(tmpdir(), "spawn-bench-"));
mkdirSync(join(tmp, ".agents/agents"), { recursive: true });
writeFileSync(
	join(tmp, ".agents/agents/reviewer.md"),
	"---\nname: reviewer\ndescription: audits pull requests for security and style\nmodel: claude-opus-4-6\ntools: read, grep, find\n---\nYou are a reviewer.",
);
{
	const t0 = performance.now();
	for (let i = 0; i < 1000; i++) resolveAgentFile("r", "review the pull request for security issues", tmp, AGENT_DIR);
	console.log(`agent-file resolve (file hit, x1000 avg) ${((performance.now() - t0) / 1000).toFixed(3)}ms/call`);
	const t1 = performance.now();
	for (let i = 0; i < 1000; i++) resolveAgentFile("nobody", "count lines of code", tmp, AGENT_DIR);
	console.log(`agent-file resolve (miss,   x1000 avg) ${((performance.now() - t1) / 1000).toFixed(3)}ms/call`);
}
rmSync(tmp, { recursive: true, force: true });

for (let run = 1; run <= RUNS; run++) {
	console.log(`\n— pipeline run ${run}/${RUNS} (no LLM) —`);
	// 1. child model runtime (createChildModelRuntime replica): disk auth/models + provider replay + refresh
	const runtime = await phase("ModelRuntime.create+refresh", async () => {
		const rt = await ModelRuntime.create({
			authPath: join(AGENT_DIR, "auth.json"),
			modelsPath: join(AGENT_DIR, "models.json"),
		});
		await rt.refresh({ allowNetwork: false });
		return rt;
	});
	// 2. resource loader (runChild uses DefaultResourceLoader + reload)
	const loader = await phase("DefaultResourceLoader reload", async () => {
		const l = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true });
		await l.reload();
		return l;
	});
	// 3. session manager
	const sm = await phase("SessionManager.create", async () => SessionManager.create(CWD, undefined, {}));
	// 4. agent session (model client init, no prompt)
	const created = await phase("createAgentSession", async () => {
		const models = await runtime.getAvailable();
		return createAgentSession({
			cwd: CWD,
			agentDir: AGENT_DIR,
			modelRuntime: runtime,
			resourceLoader: loader,
			sessionManager: sm,
			model: models.find((m) => m.id === "gemma-4-31b-it"),
			tools: ["read", "grep", "find", "ls"],
		});
	});
	created.session.dispose();
}

// Phase 5: real end-to-end — spawn until the child starts producing output
console.log(`\n— end-to-end: spawn → first model output (${MODEL}) —`);
const t0 = performance.now();
const runtime = await ModelRuntime.create({
	authPath: join(AGENT_DIR, "auth.json"),
	modelsPath: join(AGENT_DIR, "models.json"),
});
await runtime.refresh({ allowNetwork: false });
const loader = new DefaultResourceLoader({ cwd: CWD, agentDir: AGENT_DIR, noExtensions: true });
await loader.reload();
const created = await createAgentSession({
	cwd: CWD,
	agentDir: AGENT_DIR,
	modelRuntime: runtime,
	resourceLoader: loader,
	sessionManager: SessionManager.create(CWD, undefined, {}),
	model: (await runtime.getAvailable()).find((m) => m.id === "gemma-4-31b-it"),
	tools: ["read", "grep", "find", "ls"],
});
console.log(`  session ready                                     ${(performance.now() - t0).toFixed(1)}ms`);
let firstOutput = 0;
const done = new Promise<void>((resolve) => {
	const unsub = created.session.subscribe((e) => {
		if (e.type === "message_update" && !firstOutput) firstOutput = performance.now() - t0;
		if (e.type === "agent_settled") {
			unsub();
			resolve();
		}
	});
});
await created.session.prompt("Reply with exactly: OK", { source: "extension" });
await done;
console.log(`  first message_update                              ${firstOutput.toFixed(0)}ms`);
console.log(`  settled (finished)                                ${(performance.now() - t0).toFixed(0)}ms`);
created.session.dispose();
