import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { join, resolve } from "node:path";

export interface Worktree {
	root: string;
	path: string;
	branch: string;
	base: string;
}

const BRANCH_PREFIX = "subagents/";

const COMMIT_CONFIG = ["-c", "commit.gpgsign=false", "-c", "user.name=pi subagent", "-c", "user.email=subagent@local"];
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const GIT_STDIO: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];

function git(root: string, args: string[]): string {
	return gitRaw(root, args).trim();
}

function gitRaw(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: GIT_STDIO,
	});
}

function gitIn(dir: string, args: string[]): string {
	return execFileSync("git", [...args], {
		cwd: dir,
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: GIT_STDIO,
	}).trim();
}

function gitOk(root: string, args: string[]): boolean {
	try {
		git(root, args);
		return true;
	} catch {
		return false;
	}
}

function samePath(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

export function repoRoot(cwd: string): string | undefined {
	if (!existsSync(cwd)) return undefined;
	try {
		return git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return undefined;
	}
}

export function createWorktree(cwd: string, runId: string, taskId: string, baseRef?: string): Worktree | undefined {
	const root = repoRoot(cwd);
	if (!root) return undefined;

	const container = subagentsDir(root);
	if (!container) return undefined;
	let base: string;
	try {
		base = git(root, ["rev-parse", baseRef ?? "HEAD"]);
	} catch {
		if (!baseRef) return undefined;
		try {
			base = git(root, ["rev-parse", "HEAD"]);
		} catch {
			return undefined;
		}
	}
	const path = join(container, runId, taskId);
	const branch = `${BRANCH_PREFIX}${runId}/${taskId}`;

	git(root, ["worktree", "add", "-b", branch, path, base]);

	const nm = join(root, "node_modules");
	if (existsSync(nm) && !existsSync(join(path, "node_modules"))) {
		try {
			symlinkSync(nm, join(path, "node_modules"));
		} catch {}
	}
	return { root, path, branch, base };
}

export function commitWorktree(wt: Worktree, message: string): "committed" | "empty" {
	return commitIn(wt.path, message, wt.branch);
}

function commitIn(dir: string, message: string, expectBranch?: string): "committed" | "empty" {
	if (expectBranch) {
		let head = "detached";
		try {
			head = gitIn(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "detached";
		} catch {
			head = "detached";
		}
		if (head !== expectBranch) throw new Error(`worktree HEAD is "${head}", expected ${expectBranch}`);
	}

	gitIn(dir, ["add", "-A", "--", ".", ":(exclude)node_modules", ":(exclude,glob)**/node_modules/**"]);
	if (gitIn(dir, ["diff", "--cached", "--name-only"]).length === 0) return "empty";
	gitIn(dir, [...COMMIT_CONFIG, "commit", "-m", message, "--no-verify"]);
	return "committed";
}

export function branchDiff(wt: Worktree): { stat: string; files: string[] } {
	const files = git(wt.root, ["diff", "--name-only", `${wt.base}...${wt.branch}`])
		.split("\n")
		.filter(Boolean);
	const stat = git(wt.root, ["diff", "--stat", `${wt.base}...${wt.branch}`]);
	return { stat, files };
}

export function removeWorktree(wt: Worktree): void {
	dropDir(wt.root, wt.path);
}

export function removeByBranch(cwd: string, branch: string): void {
	if (!branch.startsWith(BRANCH_PREFIX)) return;
	const root = repoRoot(cwd);
	if (!root) return;
	const container = subagentsDir(root);
	if (container) dropDir(root, join(container, branch.slice(BRANCH_PREFIX.length)));
}

function subagentsDir(root: string): string | undefined {
	try {
		return join(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "subagents");
	} catch {
		try {
			return join(resolve(root, git(root, ["rev-parse", "--git-common-dir"])), "subagents");
		} catch {
			return undefined;
		}
	}
}

function ownerFile(path: string): string {
	return `${path}.owner`;
}

function dropDir(root: string, path: string): void {
	try {
		git(root, ["worktree", "remove", "--force", path]);
	} catch {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
	rmSync(ownerFile(path), { force: true });
	prune(root);
}

function prune(root: string): void {
	try {
		git(root, ["worktree", "prune"]);
	} catch {}
}

function isCheckedOut(root: string, branch: string): boolean {
	const branches = worktreeBranches(root);
	return branches === undefined || branches.includes(branch);
}

export function cleanupMerged(root: string, opts: { skipBranches?: Set<string>; target?: string } = {}): number {
	root = realpathSync(root);
	const target = opts.target ?? "HEAD";
	const merged = git(root, ["branch", "--merged", target])
		.split("\n")
		.map((b) => b.trim().replace(/^[+*]\s*/, ""));
	let cleaned = 0;
	const container = subagentsDir(root);
	for (const branch of merged) {
		if (!branch.startsWith(BRANCH_PREFIX) || !container) continue;
		if (opts.skipBranches?.has(branch)) continue;
		if (isCheckedOut(root, branch)) continue;
		const path = join(container, branch.slice(BRANCH_PREFIX.length));
		if (existsSync(path) && ownerAlive(path)) continue;

		if (!gitOk(root, ["branch", "-d", branch])) continue;
		if (existsSync(path)) {
			try {
				git(root, ["worktree", "remove", "--force", path]);
			} catch {}
		}
		rmSync(ownerFile(path), { force: true });
		cleaned += 1;
	}
	prune(root);
	pruneEmptyRunDirs(root);
	return cleaned;
}

function pruneEmptyRunDirs(root: string): void {
	const sub = subagentsDir(root);
	if (!sub || !existsSync(sub)) return;
	try {
		for (const entry of readdirSync(sub, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const runDir = join(sub, entry.name);
			try {
				if (readdirSync(runDir).length === 0) rmSync(runDir, { recursive: true, force: true });
			} catch {}
		}
	} catch {}
}

function worktreeBranches(root: string): string[] | undefined {
	const listing = worktreeListing(root);
	return listing?.filter((l) => l.startsWith("branch ")).map((l) => l.slice("branch refs/heads/".length));
}

export function reapDeadWorktrees(root: string, isLive: (path: string) => boolean = () => false): number {
	root = realpathSync(root);
	const sub = subagentsDir(root);
	if (!sub || !existsSync(sub)) return 0;
	const registered = worktreePaths(root);
	if (!registered) return 0;
	let reaped = 0;
	for (const path of registered) {
		if (!isInside(path, sub)) continue;
		if (isLive(path)) continue;
		try {
			commitIn(path, "subagent (recovered after interrupted session)");
		} catch {
			try {
				execFileSync("git", ["-C", path, "rev-parse", "--git-dir"], {
					encoding: "utf8",
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: GIT_MAX_BUFFER,
				});
				continue;
			} catch {
				dropDir(root, path);
				reaped += 1;
			}
			continue;
		}
		dropDir(root, path);
		reaped += 1;
	}
	return reaped;
}

export function claimWorktree(wt: Worktree): void {
	try {
		writeFileSync(
			ownerFile(wt.path),
			JSON.stringify({ pid: process.pid, host: hostname(), boot: bootId(), at: Date.now() }),
		);
	} catch {}
}

export function ownerAlive(path: string, ownedHere?: (path: string) => boolean): boolean {
	let marker: { pid?: number; host?: string; boot?: string };
	try {
		marker = JSON.parse(readFileSync(ownerFile(path), "utf8"));
	} catch {
		return false;
	}
	const pid = marker.pid;
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	if (marker.host !== hostname()) return true;
	if (marker.boot !== bootId()) return false;

	if (pid === process.pid) return ownedHere?.(path) ?? true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

function bootId(): string {
	try {
		if (process.platform === "linux") return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (process.platform === "darwin") {
			const out = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" });
			return out.match(/sec = (\d+)/)?.[1] ?? out.trim();
		}
	} catch {}
	return String(Math.floor((Date.now() - uptime() * 1000) / 1000));
}

export function sweepStale(root: string): void {
	root = realpathSync(root);
	const sub = subagentsDir(root);
	if (!sub || !existsSync(sub)) return;
	const registered = worktreePaths(root);

	if (!registered) return;

	for (const runDir of readdirSync(sub, { withFileTypes: true })) {
		if (!runDir.isDirectory()) continue;
		const runPath = join(sub, runDir.name);
		try {
			if (readdirSync(runPath).length === 0) rmSync(runPath, { recursive: true, force: true });
		} catch {}
	}
	for (const runDir of readDirs(sub)) {
		for (const taskDir of readDirs(join(sub, runDir))) {
			const dir = join(sub, runDir, taskDir);
			if (registered.some((p) => samePath(p, dir))) continue;
			if (ownerAlive(dir)) continue;
			rmSync(dir, { recursive: true, force: true });
			rmSync(ownerFile(dir), { force: true });
		}
	}
	prune(root);
}

function worktreePaths(root: string): string[] | undefined {
	const listing = worktreeListing(root);
	return listing?.filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

function worktreeListing(root: string): string[] | undefined {
	try {
		return gitRaw(root, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter(Boolean);
	} catch {
		try {
			return git(root, ["worktree", "list", "--porcelain"]).split("\n").filter(Boolean);
		} catch {
			return undefined;
		}
	}
}

function isInside(path: string, dir: string): boolean {
	const p = safeReal(path);
	const d = safeReal(dir);
	return p === d || p.startsWith(`${d}/`);
}

function safeReal(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function readDirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
}
