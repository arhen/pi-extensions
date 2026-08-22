/** Git worktree isolation for write subagents.
 *  Worktrees live inside `<repo>/.git/subagents/<runId>/<taskId>` so the child's
 *  ancestor walk still finds the project AGENTS.md chain. node_modules is
 *  symlinked from the main tree. The extension commits the child's changes on
 *  completion; the leader reviews and merges the branch manually; merged
 *  branches are cleaned automatically, crash leftovers are swept at session
 *  start (dir removed, branch kept — the work survives). */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export interface Worktree {
	root: string; // repo root (main tree)
	path: string; // worktree checkout dir
	branch: string; // subagents/<runId>/<taskId>
	base: string; // SHA the branch was created from
}

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
	const branch = `subagents/${runId}/${taskId}`;
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

/** Commit all child changes. No-op when the worktree is already clean. */
export function commitWorktree(wt: Worktree, message: string): void {
	if (gitIn(wt.path, ["status", "--porcelain"]).length === 0) return;
	gitIn(wt.path, ["add", "-A", "--", ".", ":(exclude)node_modules"]); // never stage the dep symlink
	gitIn(wt.path, ["commit", "-m", message, "--no-verify"]);
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
	try {
		git(wt.root, ["worktree", "remove", "--force", wt.path]);
	} catch {
		/* already gone */
	}
	prune(wt.root);
}

/** Remove a worktree dir by branch name (cancel paths that didn't keep a Worktree). */
export function removeByBranch(cwd: string, branch: string): void {
	const root = repoRoot(cwd);
	if (!root) return;
	const path = join(root, ".git", "subagents", branch.slice("subagents/".length));
	try {
		git(root, ["worktree", "remove", "--force", path]);
	} catch {
		/* already gone */
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

/**
 * Delete branch + worktree for branches already merged into `target`.
 * SAFETY: branches checked out in a LIVE worktree (concurrent run) are skipped —
 * their tip equals the base until the child commits, so they look "merged".
 */
export function cleanupMerged(root: string, target = "HEAD"): number {
	root = realpathSync(root);
	const merged = git(root, ["branch", "--merged", target])
		.split("\n")
		.map((b) => b.trim().replace(/^[+*]\s*/, ""));
	const live = new Set(worktreeBranches(root));
	let cleaned = 0;
	for (const branch of merged) {
		if (!branch.startsWith("subagents/") || live.has(branch)) continue;
		const path = join(root, ".git", "subagents", branch.slice("subagents/".length));
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
 * Remove worktree dirs that are NOT registered worktrees (crash leftovers).
 * A crash leaves the dir AND the branch, so branch-existence can't identify
 * leftovers — worktree registration can. Branches always survive.
 */
export function sweepStale(root: string): void {
	root = realpathSync(root);
	const sub = join(root, ".git", "subagents");
	if (!existsSync(sub)) return;
	const registered = new Set(worktreePaths(root));
	for (const runDir of readDirs(sub)) {
		for (const taskDir of readDirs(join(sub, runDir))) {
			const dir = join(sub, runDir, taskDir);
			if (registered.has(dir)) continue; // live worktree
			try {
				git(root, ["worktree", "remove", "--force", dir]);
			} catch {
				// dir not a registered worktree (partial crash) — plain rm
				rmSync(dir, { recursive: true, force: true });
			}
		}
	}
	prune(root);
}

function worktreePaths(root: string): string[] {
	try {
		return git(root, ["worktree", "list", "--porcelain"])
			.split("\n")
			.filter((l) => l.startsWith("worktree "))
			.map((l) => l.slice("worktree ".length).trim());
	} catch {
		return [];
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
