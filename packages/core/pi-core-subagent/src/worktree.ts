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
import { existsSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

/** git C-quotes porcelain paths containing spaces/specials — undo that. */
function unquote(path: string): string {
	if (!path.startsWith('"') || !path.endsWith('"')) return path;
	return path
		.slice(1, -1)
		.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8)))
		.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c as string] ?? c);
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
	const path = join(root, ".git", "subagents", runId, taskId);
	const branch = `${BRANCH_PREFIX}${runId}/${taskId}`;
	let base: string;
	try {
		base = git(root, ["rev-parse", "HEAD"]); // SHA — detached HEAD stays correct
	} catch {
		return undefined; // broken repo — fall back to in-place
	}
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
 * turn into a failed empty commit.
 */
export function commitWorktree(wt: Worktree, message: string): void {
	commitIn(wt.path, message);
}

function commitIn(dir: string, message: string): void {
	gitIn(dir, ["add", "-A", "--", ".", ":(exclude)node_modules"]); // never stage the dep symlink
	if (gitIn(dir, ["diff", "--cached", "--name-only"]).length === 0) return; // nothing to commit
	gitIn(dir, ["commit", "-m", message, "--no-verify"]);
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
	dropDir(root, join(root, ".git", "subagents", branch.slice(BRANCH_PREFIX.length)));
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
	for (const branch of merged) {
		if (!branch.startsWith(BRANCH_PREFIX)) continue;
		if (opts.skipBranches?.has(branch)) continue; // owned by a live run
		if (isCheckedOut(root, branch)) continue; // fresh re-check, not a stale snapshot
		const path = join(root, ".git", "subagents", branch.slice(BRANCH_PREFIX.length));
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
		return git(root, ["worktree", "list", "--porcelain"])
			.split("\n")
			.filter((l) => l.startsWith("branch "))
			.map((l) => l.slice("branch refs/heads/".length).trim());
	} catch {
		return [];
	}
}

/**
 * Session-start recovery: every registered subagent worktree is a crash leftover
 * (nothing of ours can be live yet). Commit whatever the dead child left so the
 * branch keeps it, then drop the dir. Branches always survive.
 */
export function reapDeadWorktrees(root: string): number {
	root = realpathSync(root);
	const sub = join(root, ".git", "subagents");
	if (!existsSync(sub)) return 0;
	let reaped = 0;
	for (const path of worktreePaths(root)) {
		if (!isInside(path, sub)) continue; // not ours
		try {
			commitIn(path, "subagent (recovered after interrupted session)");
		} catch {
			/* nothing committable */
		}
		dropDir(root, path);
		reaped += 1;
	}
	return reaped;
}

/**
 * Remove worktree dirs that git no longer knows about (partial-crash leftovers).
 * Registered worktrees are never touched here — `reapDeadWorktrees` owns those,
 * and a live child's checkout must survive.
 */
export function sweepStale(root: string): void {
	root = realpathSync(root);
	const sub = join(root, ".git", "subagents");
	if (!existsSync(sub)) return;
	const registered = worktreePaths(root);
	for (const runDir of readDirs(sub)) {
		for (const taskDir of readDirs(join(sub, runDir))) {
			const dir = join(sub, runDir, taskDir);
			if (registered.some((p) => samePath(p, dir))) continue; // live/registered worktree
			rmSync(dir, { recursive: true, force: true });
		}
	}
	prune(root);
}

function worktreePaths(root: string): string[] {
	try {
		return git(root, ["worktree", "list", "--porcelain"])
			.split("\n")
			.filter((l) => l.startsWith("worktree "))
			.map((l) => unquote(l.slice("worktree ".length).trim()));
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
