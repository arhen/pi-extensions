/** Git worktree isolation for write subagents.
 *  Worktrees live inside `<repo>/.git/subagents/<runId>/<taskId>` so the child's
 *  ancestor walk still finds the project AGENTS.md chain. node_modules is
 *  symlinked from the main tree. The extension commits the child's changes on
 *  completion; the leader reviews and merges the branch manually.
 *
 *  Cleanup, in order of trust: `reapDeadWorktrees` (session start — nothing can
 *  be live yet, so every registered worktree is a crash leftover: commit its
 *  work, drop the dir, keep the branch), `cleanupMerged` (merged branches, never
 *  touching a checked-out one), `sweepStale` (dirs git no longer knows about). */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Worktree {
	root: string; // repo root (main tree)
	path: string; // worktree checkout dir
	branch: string; // subagents/<runId>/<taskId>
	base: string; // SHA the branch was created from
}

const BRANCH_PREFIX = "subagents/";

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/** Run git directly inside a directory (worktree ops). */
function gitIn(dir: string, args: string[]): string {
	return execFileSync("git", [...args], { cwd: dir, encoding: "utf8" }).trim();
}

function gitOk(root: string, args: string[]): boolean {
	try {
		git(root, args);
		return true;
	} catch {
		return false;
	}
}

/** Compare paths through realpath so /var vs /private/var can't diverge. */
function samePath(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return false;
	}
}

/** Repo root for cwd, or undefined when not a git repo (or cwd doesn't exist). */
export function repoRoot(cwd: string): string | undefined {
	if (!existsSync(cwd)) return undefined;
	try {
		return git(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return undefined;
	}
}

/** Create an isolated worktree for a write task. Returns undefined when not a git repo. */
export function createWorktree(cwd: string, runId: string, taskId: string): Worktree | undefined {
	const root = repoRoot(cwd);
	if (!root) return undefined;
	// --git-common-dir, not "<root>/.git": inside a linked worktree or a submodule
	// `.git` is a FILE, and joining it would make `worktree add` fail (silently
	// dropping isolation).
	let container: string;
	let base: string;
	try {
		const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		container = join(common, "subagents");
		base = git(root, ["rev-parse", "HEAD"]); // SHA — detached HEAD stays correct
	} catch {
		return undefined; // broken repo — fall back to in-place
	}
	const path = join(container, runId, taskId);
	const branch = `${BRANCH_PREFIX}${runId}/${taskId}`;
	git(root, ["worktree", "add", "-b", branch, path, "HEAD"]);
	// Deps follow the child into the worktree; anything else the task needs is
	// project content already checked out there.
	const nm = join(root, "node_modules");
	if (existsSync(nm) && !existsSync(join(path, "node_modules"))) {
		try {
			symlinkSync(nm, join(path, "node_modules"));
		} catch {
			/* non-fatal: task may not need deps */
		}
	}
	return { root, path, branch, base };
}

/**
 * Commit the child's changes. Stages first, then commits only when something is
 * actually staged — an untracked node_modules symlink must not fake "dirty" and
 * turn into a failed empty commit. Returns "committed" | "empty"; a real git
 * failure THROWS, and callers must not delete the checkout in that case (the
 * work would become unreachable once the base-tip branch is reaped as merged).
 */
export function commitWorktree(wt: Worktree, message: string): "committed" | "empty" {
	return commitIn(wt.path, message);
}

function commitIn(dir: string, message: string): "committed" | "empty" {
	// Exclude the root dep symlink and any nested node_modules the child created.
	gitIn(dir, ["add", "-A", "--", ".", ":(exclude)node_modules", ":(exclude,glob)**/node_modules/**"]);
	if (gitIn(dir, ["diff", "--cached", "--name-only"]).length === 0) return "empty";
	gitIn(dir, ["commit", "-m", message, "--no-verify"]);
	return "committed";
}

/** Diffstat + changed files of the branch vs its base SHA. */
export function branchDiff(wt: Worktree): { stat: string; files: string[] } {
	const files = git(wt.root, ["diff", "--name-only", `${wt.base}...${wt.branch}`])
		.split("\n")
		.filter(Boolean);
	const stat = git(wt.root, ["diff", "--stat", `${wt.base}...${wt.branch}`]);
	return { stat, files };
}

/** Remove the worktree dir. The branch is KEPT (the work survives for merging). */
export function removeWorktree(wt: Worktree): void {
	dropDir(wt.root, wt.path);
}

/** Remove a worktree dir by branch name (cancel paths that didn't keep a Worktree). */
export function removeByBranch(cwd: string, branch: string): void {
	if (!branch.startsWith(BRANCH_PREFIX)) return;
	const root = repoRoot(cwd);
	if (!root) return;
	const container = subagentsDir(root);
	if (container) dropDir(root, join(container, branch.slice(BRANCH_PREFIX.length)));
}

/** `<git-common-dir>/subagents` — where our worktrees live for this repo. */
function subagentsDir(root: string): string | undefined {
	try {
		return join(git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "subagents");
	} catch {
		return undefined;
	}
}

function dropDir(root: string, path: string): void {
	try {
		git(root, ["worktree", "remove", "--force", path]);
	} catch {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
	prune(root);
}

/** Drop git's stale worktree admin entries (they pile up under .git/worktrees). */
function prune(root: string): void {
	try {
		git(root, ["worktree", "prune"]);
	} catch {
		/* ignore */
	}
}

/** Is this branch checked out in some worktree right now? Checked fresh, per call. */
function isCheckedOut(root: string, branch: string): boolean {
	return worktreeBranches(root).includes(branch);
}

/**
 * Delete branch + worktree for branches already merged into `target`.
 * SAFETY: a branch checked out in a LIVE worktree is skipped — a fresh branch's
 * tip equals its base until the child commits, so it looks "merged". The
 * registration is re-checked immediately before each removal (a concurrent run
 * may have created its worktree after the first listing).
 */
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
		if (opts.skipBranches?.has(branch)) continue; // owned by a live run
		if (isCheckedOut(root, branch)) continue; // fresh re-check, not a stale snapshot
		const path = join(container, branch.slice(BRANCH_PREFIX.length));
		if (existsSync(path) && ownerAlive(path)) continue; // another session's live checkout
		if (existsSync(path)) {
			try {
				git(root, ["worktree", "remove", "--force", path]);
			} catch {
				continue;
			}
		}
		if (gitOk(root, ["branch", "-d", branch])) cleaned += 1;
	}
	prune(root);
	return cleaned;
}

/** Branch names currently checked out in any worktree (incl. the main one). */
function worktreeBranches(root: string): string[] {
	try {
		return git(root, ["worktree", "list", "--porcelain", "-z"])
			.split("\0")
			.filter((l) => l.startsWith("branch "))
			.map((l) => l.slice("branch refs/heads/".length));
	} catch {
		return [];
	}
}

/**
 * Session-start recovery: every registered subagent worktree is a crash leftover
 * (nothing of ours can be live yet). Commit whatever the dead child left so the
 * branch keeps it, then drop the dir. Branches always survive.
 */
export function reapDeadWorktrees(root: string, isLive: (path: string) => boolean = () => false): number {
	root = realpathSync(root);
	const sub = subagentsDir(root);
	if (!sub || !existsSync(sub)) return 0;
	let reaped = 0;
	for (const path of worktreePaths(root)) {
		if (!isInside(path, sub)) continue; // not ours
		if (isLive(path)) continue; // another pi session owns it
		try {
			commitIn(path, "subagent (recovered after interrupted session)");
		} catch {
			continue; // git failed — never drop a dir whose work isn't on the branch
		}
		dropDir(root, path);
		reaped += 1;
	}
	return reaped;
}

/**
 * Ownership marker: a live worktree gets `<dir>/.subagent-owner` holding the
 * owning pid. Another pi session must not reap a checkout whose owner is alive.
 */
export function claimWorktree(wt: Worktree): void {
	try {
		writeFileSync(join(wt.path, ".subagent-owner"), String(process.pid));
	} catch {
		/* best-effort: worst case another session reaps it after a crash */
	}
}

/** True when the worktree dir is claimed by a process that still exists. */
export function ownerAlive(path: string): boolean {
	try {
		const pid = Number.parseInt(readFileSync(join(path, ".subagent-owner"), "utf8").trim(), 10);
		if (!Number.isFinite(pid) || pid <= 0) return false;
		if (pid === process.pid) return true;
		process.kill(pid, 0); // throws ESRCH when the owner is gone
		return true;
	} catch {
		return false;
	}
}

/**
 * Remove worktree dirs that git no longer knows about (partial-crash leftovers).
 * Registered worktrees are never touched here — `reapDeadWorktrees` owns those,
 * and a live child's checkout must survive.
 */
export function sweepStale(root: string): void {
	root = realpathSync(root);
	const sub = subagentsDir(root);
	if (!sub || !existsSync(sub)) return;
	const registered = worktreePaths(root);
	for (const runDir of readDirs(sub)) {
		for (const taskDir of readDirs(join(sub, runDir))) {
			const dir = join(sub, runDir, taskDir);
			if (registered.some((p) => samePath(p, dir))) continue; // live/registered worktree
			if (ownerAlive(dir)) continue; // claimed by a running session
			rmSync(dir, { recursive: true, force: true });
		}
	}
	prune(root);
}

/** Registered worktree paths. `-z` keeps paths verbatim (no C-quoting to undo). */
function worktreePaths(root: string): string[] {
	try {
		return git(root, ["worktree", "list", "--porcelain", "-z"])
			.split("\0")
			.filter((l) => l.startsWith("worktree "))
			.map((l) => l.slice("worktree ".length));
	} catch {
		return [];
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
