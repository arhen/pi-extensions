// code-diagnostic.ts — pi extension: repo-scoped check loop.
// LSP-equivalent diagnostics, no servers: one configured command per repo,
// run at agent settle (global) + optional per-file command buffered on write/edit.
//
// Config per repo root: ~/.pi/repos/<root-sanitized>.json
//   { "check": "tsc --noEmit", "fileCheck": "eslint ${file}", "enabled": true,
//     "testedAt": "...", "lastExit": 0, "parentRoot": "/path/to/parent" }
// Missing config → one steering message per session asks the agent to discover
// the repo's check commands, self-test them, confirm with the user, and write
// the config. No config that matches → enabled:false, silent forever after.
//
// ⚠️ shell operators (&&  |  ;  redirects  subshells) in a check are wrapped in
//    `bash -lc` so repo commands like "npm install && npm run check" work — no naive
//    whitespace split (which would hand npm a literal "&&" arg). Plain single-command
//    checks still run argv-direct. ponytail-lazy: no shell always; bash only on demand.
const SHELL_OP = /[&|;><`()]/; // substring-only `$` (env, ${file}) is NOT an operator

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REPO_DIR = path.join(os.homedir(), ".pi", "repos");
const MAX_ROOTS = 3;
const BAD_RUNS_TO_DISABLE = 3;
// ponytail: flat char cap on what enters the agent's context.
// Upgrade path: per-section budget if truncation ever hides real errors.
const MAX_REPORT = 4000;

interface CheckConfig {
	check: string;
	fileCheck?: string;
	enabled: boolean;
	testedAt?: string;
	lastExit?: number;
	parentRoot?: string;
}

export function sanitize(root: string): string {
	return root.replace(/[\/\\:]/g, "_");
}
export function configPath(root: string): string {
	return path.join(REPO_DIR, sanitize(root) + ".json");
}
export function readConfig(root: string): CheckConfig | null {
	try {
		const c = JSON.parse(fs.readFileSync(configPath(root), "utf8")) as CheckConfig;
		// agent-written file: reject any shape we'd otherwise spawn blindly
		if (!c || typeof c.check !== "string" || !c.check.trim()) return null;
		if (typeof c.fileCheck !== "string" || !c.fileCheck.trim()) delete c.fileCheck;
		c.enabled = c.enabled !== false;
		return c;
	} catch {
		return null;
	}
}
export function hasGitMarker(dir: string): boolean {
	return fs.existsSync(path.join(dir, ".git"));
}
/** Nearest repo roots walking up from cwd (non-git cwd counts as root). */
export function repoRootsUp(cwd: string): string[] {
	const roots: string[] = [];
	let dir = path.resolve(cwd);
	for (let i = 0; i <= MAX_ROOTS; i++) {
		if (hasGitMarker(dir)) {
			roots.push(dir);
		} else if (i === 0) {
			roots.push(dir); // non-git cwd
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return roots.slice(0, MAX_ROOTS);
}
/** Nearest config wins; inherits parent repo's config when nested repo unconfigured. */
export function findConfig(cwd: string): { config: CheckConfig; root: string } | null {
	for (const root of repoRootsUp(cwd)) {
		const config = readConfig(root);
		if (config) return { config, root };
	}
	return null;
}
/** Empty input yields cmd "" — callers must skip it, spawn("") throws. */
export function splitCmd(s: string): [string, string[]] {
	const t = s.trim();
	if (!t) return ["", []];
	if (SHELL_OP.test(t)) return ["bash", ["-lc", t]];
	const [cmd = "", ...args] = t.split(/\s+/).filter(Boolean);
	return [cmd, args];
}
/** Substitute after the split so a path with spaces stays one argv entry. */
export function splitFileCmd(template: string, file: string): [string, string[]] {
	const t = template.trim();
	if (SHELL_OP.test(t)) return ["bash", ["-lc", t.replaceAll("${file}", file)]];
	const [cmd, args] = splitCmd(t);
	return [cmd.replaceAll("${file}", file), args.map((a) => a.replaceAll("${file}", file))];
}
/** write tool accepts file_path or path; edit uses path. */
export function editedPath(input: Record<string, unknown> | undefined): string {
	const p = input?.file_path ?? input?.path;
	return typeof p === "string" ? p : "";
}
/**
 * A nonzero exit only means "command is broken" when it produced no diagnostics.
 * A working checker exits nonzero precisely when it finds errors, so counting that
 * as a bad run disables the config on the third genuine report.
 */
export function isBrokenRun(res: { stdout: string; stderr: string; code: number }): boolean {
	return res.code === 127 || !(res.stdout + res.stderr).trim();
}
export function truncate(s: string, max = MAX_REPORT): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n… (${s.length - max} more chars truncated)`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("diagnostic", {
		description: "show code-diagnostic config, run check now, or clear config",
		getArgumentCompletions: (prefix) =>
			["status", "run", "clear"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0];
			const found = findConfig(ctx.cwd);
			if (sub === "clear") {
				let removed = 0;
				for (const root of repoRootsUp(ctx.cwd)) {
					const p = configPath(root);
					if (fs.existsSync(p)) {
						fs.unlinkSync(p);
						removed++;
					}
				}
				loadFor(ctx.cwd);
				ctx.ui.notify(removed ? `code-diagnostic config cleared (${removed}) — discovery will re-run` : "no config found to clear", "info");
				return;
			}
			if (sub === "run") {
				if (!found) {
					ctx.ui.notify("no code-diagnostic config for this repo yet — run /diagnostic or wait for discovery", "info");
					return;
				}
				if (!found.config.enabled) {
					ctx.ui.notify("code-diagnostic disabled for this repo (enabled:false)", "info");
					return;
				}
				const out = await runCheck(found.config, found.root);
				ctx.ui.notify(out ? `check failed:\n${out.slice(0, 500)}` : "check passed", out ? "error" : "info");
				return;
			}
			// default status
			if (!found) {
				ctx.ui.notify("no code-diagnostic config for this repo — discovery will propose one", "info");
				return;
			}
			const c = found.config;
			ctx.ui.notify(
				`root: ${found.root}\n` +
					`check: ${c.check}\n` +
					`fileCheck: ${c.fileCheck ?? "—"}\n` +
					`enabled: ${c.enabled}\n` +
					`testedAt: ${c.testedAt ?? "—"}\n` +
					`lastExit: ${c.lastExit ?? "—"}`,
				c.enabled ? "info" : "warning",
			);
		},
	});

	// per-repo-root state, re-resolved every session (config can change on disk)
	let current: { config: CheckConfig; root: string } | null = null;
	let fileErrors = new Map<string, string>(); // path -> formatted errors (latest per path)
	let badRuns = 0;
	let lastReport = "";
	let dirtySinceReport = false; // any file-mutating tool call since last report
	const inFlight = new Set<Promise<unknown>>(); // fileCheck runs not yet folded into fileErrors
	let timeoutReported = false; // check exceeded its timeout — say so once, not every settle
	let checkedOnce = false; // baseline check done this session
	let askedDiscovery = false; // discovery steering sent this session
	let lastRunAborted = false; // last agent run ended aborted/errored

	function loadFor(cwd: string) {
		fileErrors.clear();
		badRuns = 0;
		lastReport = "";
		dirtySinceReport = false;
		inFlight.clear();
		timeoutReported = false;
		checkedOnce = false;
		askedDiscovery = false;
		lastRunAborted = false;
		current = findConfig(cwd);
	}

	async function runCheck(config: CheckConfig, root: string): Promise<string> {
		const [cmd, args] = splitCmd(config.check);
		if (!cmd) return "";
		const res = await pi.exec(cmd, args, { cwd: root, timeout: 120_000 }).catch(() => null);
		if (!res) return "";
		if (res.killed) {
			// silent 120s burn on every settle otherwise — surface it once so the config can be fixed
			if (timeoutReported) return "";
			timeoutReported = true;
			badRuns++;
			return "timed out after 120s — check command is too slow or hung";
		}
		if (res.code === 0) {
			badRuns = 0;
			timeoutReported = false;
			return "";
		}
		const diagnostics = (res.stdout + "\n" + res.stderr).trim();
		if (!isBrokenRun(res)) {
			badRuns = 0; // real diagnostics: the command works, it just found errors
			return diagnostics;
		}
		badRuns++;
		if (badRuns >= BAD_RUNS_TO_DISABLE) {
			config.enabled = false; // crashing/wrong command — stop, re-discover
			fs.mkdirSync(REPO_DIR, { recursive: true });
			fs.writeFileSync(configPath(root), JSON.stringify(config, null, 2));
		}
		return diagnostics || `exit ${res.code}`;
	}

	pi.on("session_start", async (_event, ctx) => {
		loadFor(ctx.cwd);
	});

	// agent_settled carries no messages — capture abort state from agent_end, which does.
	pi.on("agent_end", async (event) => {
		lastRunAborted = event.messages.some(
			(m) => m.role === "assistant" && (m.stopReason === "aborted" || m.stopReason === "error"),
		);
	});

	// Tier 1: per-file check on write/edit — silent, async, never blocks the agent.
	pi.on("tool_result", async (event, ctx) => {
		// bash mutates files constantly (sed -i, mv, rm, git checkout, formatters, codegen),
		// so it must mark the tree dirty even though there is no single file to lint.
		if (event.toolName === "bash") {
			dirtySinceReport = true;
			return;
		}
		if (event.toolName !== "write" && event.toolName !== "edit") return;
		dirtySinceReport = true;
		const config = current?.config;
		if (!config?.enabled || !config.fileCheck) return;
		const file = editedPath(event.input);
		if (!file) return;
		const [cmd, args] = splitFileCmd(config.fileCheck, file);
		if (!cmd) return;
		const root = current?.root ?? ctx.cwd; // match runCheck: linters resolve config from the repo root
		const run = pi
			.exec(cmd, args, { cwd: root, timeout: 30_000 })
			.then((res) => {
				if (res.killed) return;
				if (res.code === 0) {
					fileErrors.delete(file); // fixed since the last edit — don't report the stale error
					return;
				}
				fileErrors.set(file, (res.stdout + "\n" + res.stderr).trim());
			})
			.catch(() => {}) // fail-open: a broken fileCheck never blocks
			.finally(() => inFlight.delete(run));
		inFlight.add(run);
	});

	// Tier 2: global check + buffered file errors reported once the agent settles.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!current) current = findConfig(ctx.cwd); // discovery may have written config this session
		if (!current) {
			if (!askedDiscovery) {
				// no config seen this session — ask the agent to discover it, once, and only for real projects
				askedDiscovery = true;
				const probe = repoRootsUp(ctx.cwd).find(hasGitMarker);
				if (!probe) return; // non-git dir (home, scratch): nothing to check here, stay silent
				pi.sendMessage(
					{
						customType: "code-diagnostic-discovery",
						display: true,
						content: [
							`This repo (${probe}) has no code-diagnostic config yet.`,
							`Discover it once: inspect the repo (package.json scripts, tsconfig.json, Cargo.toml, go.mod, CMakeLists.txt...),`,
							"propose a `check` command (and optional `fileCheck` with ${file} placeholder for per-file linting).",
							"Self-test the proposed command once via your bash tool, then ask the user (ask_user_question, single select):",
							"keep → write config JSON {check, fileCheck?, enabled: true} to " + configPath(probe),
							"rescan → propose a different command (max 2 attempts)",
							"off → write {check, enabled: false}",
							"If nothing in this repo fits any checker, write {check: '<repo build/check command>', enabled: true} or off.",
							"Keep the schema exactly as specified. Do not add fields.",
						].join("\n"),
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
			return;
		}
		const { config, root } = current;
		if (!config.enabled || lastRunAborted) return;
		if (!dirtySinceReport && checkedOnce) return; // nothing changed since last check — don't re-exec
		checkedOnce = true;

		const globalOut = await runCheck(config, root);
		// fire-and-forget fileChecks slower than the settle boundary would land after the
		// report is built and cleared, dropping the diagnostic. Bounded by the 30s exec timeout.
		if (inFlight.size) await Promise.all([...inFlight]);
		const sections: string[] = [];
		if (globalOut) sections.push(`[${config.check}] ${globalOut}`);
		for (const [file, out] of fileErrors) sections.push(`[${splitFileCmd(config.fileCheck ?? "", file).flat().join(" ")}] ${out}`);
		fileErrors.clear();
		dirtySinceReport = false;

		if (!sections.length) return;
		const report = truncate(sections.join("\n\n"));
		const same = report === lastReport;
		lastReport = report;

		// Same errors again with no edits since → show only, don't wake the agent (loop guard).
		pi.sendMessage(
			{ customType: "code-diagnostic", display: true, content: report },
			{ triggerTurn: !same, deliverAs: "followUp" },
		);
	});
}