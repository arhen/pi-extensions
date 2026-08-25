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
import { hostname, uptime } from "node:os";
import { join, resolve } from "node:path";

export interface Worktree {
	root: string; // repo root (main tree)
	path: string; // worktree checkout dir
	branch: string; // subagents/<runId>/<taskId>
	base: string; // SHA the branch was created from
}

const BRANCH_PREFIX = "subagents/";

/** Identity + signing fallbacks: a machine without user.email (CI, fresh box) or
 *  with commit.gpgsign set must not fail — or worse, block on a passphrase prompt. */
const COMMIT_CONFIG = ["-c", "commit.gpgsign=false", "-c", "user.name=pi subagent", "-c", "user.email=subagent@local"];
const GIT_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
/** Capture stderr instead of inheriting it. execFileSync only redirects stdout by
 *  default, so git's progress chatter ("Preparing worktree (new branch ...)")
 *  printed straight into the TUI and corrupted the rendered frame. Captured
 *  stderr still reaches us on failure via the thrown error. */
const GIT_STDIO: ("ignore" | "pipe")[] = ["ignore", "pipe", "pipe"];

function git(root: string, args: string[]): string {
	return gitRaw(root, args).trim();
}

/** Untrimmed git output — required for -z parsing, where a path may end in a space. */
function gitRaw(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: GIT_MAX_BUFFER,
		stdio: GIT_STDIO,
	});
}

/** Run git directly inside a directory (worktree ops). */
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

/**
 * Create an isolated worktree for a write task. Returns undefined when not a git repo.
 *
 * @param baseRef Branch/SHA to start from. A chained write task MUST pass its
 *   upstream's branch: basing on main HEAD hands the child a tree without the
 *   upstream's edits, so it "builds on" work it cannot see and its merge reverts
 *   the upstream.
 */
export function createWorktree(cwd: string, runId: string, taskId: string, baseRef?: string): Worktree | undefined {
	const root = repoRoot(cwd);
	if (!root) return undefined;
	// --git-common-dir, not "<root>/.git": inside a linked worktree or a submodule
	// `.git` is a FILE, and joining it would make `worktree add` fail (silently
	// dropping isolation).
	const container = subagentsDir(root);
	if (!container) return undefined;
	let base: string;
	try {
		// Resolve to a SHA so a later commit on the ref can't skew the diff base.
		base = git(root, ["rev-parse", baseRef ?? "HEAD"]);
	} catch {
		if (!baseRef) return undefined; // broken repo — fall back to in-place
		try {
			base = git(root, ["rev-parse", "HEAD"]); // upstream branch gone — fall back to HEAD
		} catch {
			return undefined;
		}
	}
	const path = join(container, runId, taskId);
	const branch = `${BRANCH_PREFIX}${runId}/${taskId}`;
	// Branch from the recorded SHA, not "HEAD" — a concurrent commit in the main
	// tree between the two would otherwise skew every later diff against base.
	git(root, ["worktree", "add", "-b", branch, path, base]);
	// Deps follow the child into the worktree so it can build without a reinstall.
	//
	// ponytail: this is a SHARED symlink to the main tree's node_modules, not a
	// copy — the cheap option, and it escapes isolation. A child that runs an
	// install, or `rm -rf node_modules/` (trailing slash follows the link),
	// mutates the leader's real deps outside any branch. Ceiling accepted because
	// copying/hardlinking node_modules per worktree costs GBs per task; the
	// upgrade path is a per-worktree install on an explicit opt-in flag.
	// Children are warned in their system prompt (see manager.ts childPrompt).
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
	return commitIn(wt.path, message, wt.branch);
}

function commitIn(dir: string, message: string, expectBranch?: string): "committed" | "empty" {
	// A child that detached HEAD or switched branches would commit somewhere the
	// leader is never told about — refuse rather than report a branch without the work.
	if (expectBranch) {
		// `symbolic-ref` EXITS NON-ZERO on a detached HEAD — catch it rather than
		// letting the raw git failure masquerade as a commit error.
		let head = "detached";
		try {
			head = gitIn(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "detached";
		} catch {
			head = "detached";
		}
		if (head !== expectBranch) throw new Error(`worktree HEAD is "${head}", expected ${expectBranch}`);
	}
	// Exclude the root dep symlink and any nested node_modules the child created.
	gitIn(dir, ["add", "-A", "--", ".", ":(exclude)node_modules", ":(exclude,glob)**/node_modules/**"]);
	if (gitIn(dir, ["diff", "--cached", "--name-only"]).length === 0) return "empty";
	gitIn(dir, [...COMMIT_CONFIG, "commit", "-m", message, "--no-verify"]);
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

/** `<git-common-dir>/subagents` — where our worktrees live for this repo.
 *  `--path-format` needs git ≥ 2.31; fall back to resolving the relative form. */
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

/** Marker path lives BESIDE the checkout, never inside it — a file in the worktree
 *  would be staged by `add -A`, committed into the branch, and merged into main. */
function ownerFile(path: string): string {
	return `${path}.owner`;
}

function dropDir(root: string, path: string): void {
	try {
		git(root, ["worktree", "remove", "--force", path]);
	} catch {
		if (existsSync(path)) rmSync(path, { recursive: true, force: true });
	}
	rmSync(ownerFile(path), { force: true }); // marker lives beside the dir
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

/** Is this branch checked out right now? "Unknown" counts as YES (never delete blind). */
function isCheckedOut(root: string, branch: string): boolean {
	const branches = worktreeBranches(root);
	return branches === undefined || branches.includes(branch);
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
		// Branch FIRST: `-d` refuses anything not truly merged, so a stale "merged"
		// listing can no longer cost us a checkout that still holds work.
		if (!gitOk(root, ["branch", "-d", branch])) continue;
		if (existsSync(path)) {
			try {
				git(root, ["worktree", "remove", "--force", path]);
			} catch {
				/* branch is gone; a leftover dir is swept later */
			}
		}
		rmSync(ownerFile(path), { force: true });
		cleaned += 1;
	}
	prune(root);
	pruneEmptyRunDirs(root);
	return cleaned;
}

/** Remove `<subagents>/<runId>/` once its task dirs are gone. Cleanup left these
 *  behind forever, so `.git/subagents` grew one empty dir per run. */
function pruneEmptyRunDirs(root: string): void {
	const sub = subagentsDir(root);
	if (!sub || !existsSync(sub)) return;
	try {
		for (const entry of readdirSync(sub, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const runDir = join(sub, entry.name);
			try {
				if (readdirSync(runDir).length === 0) rmSync(runDir, { recursive: true, force: true });
			} catch {
				/* skip */
			}
		}
	} catch {
		/* best-effort */
	}
}

/** Branch names currently checked out in any worktree, or undefined when git
 *  couldn't be asked — callers MUST treat undefined as "unknown", never as "none",
 *  or they will happily delete live checkouts. */
function worktreeBranches(root: string): string[] | undefined {
	const listing = worktreeListing(root);
	return listing?.filter((l) => l.startsWith("branch ")).map((l) => l.slice("branch refs/heads/".length));
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
	const registered = worktreePaths(root);
	if (!registered) return 0; // listing failed — touch nothing
	let reaped = 0;
	for (const path of registered) {
		if (!isInside(path, sub)) continue; // not ours
		if (isLive(path)) continue; // another pi session owns it
		try {
			commitIn(path, "subagent (recovered after interrupted session)");
		} catch {
			// A dir git refuses to read (half-created by a timed-out worktree add,
			// or corrupted) holds no recoverable work — drop it instead of retrying
			// forever. The "never drop uncommitted work" rule protects readable dirs.
			try {
				execFileSync("git", ["-C", path, "rev-parse", "--git-dir"], {
					encoding: "utf8",
					timeout: GIT_TIMEOUT_MS,
					maxBuffer: GIT_MAX_BUFFER,
				});
				continue; // git still reads it — legitimate work, keep
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

/**
 * Ownership marker: a live worktree gets `<dir>/.subagent-owner` holding the
 * owning pid. Another pi session must not reap a checkout whose owner is alive.
 */
export function claimWorktree(wt: Worktree): void {
	try {
		writeFileSync(
			ownerFile(wt.path),
			JSON.stringify({ pid: process.pid, host: hostname(), boot: bootId(), at: Date.now() }),
		);
	} catch {
		/* best-effort: worst case another session reaps it after a crash */
	}
}

/**
 * True when the worktree is claimed by a process that still exists HERE.
 * Guards against pid reuse across reboots (boot id) and other hosts (hostname);
 * EPERM means the pid exists under another user — alive, not reapable.
 */
export function ownerAlive(path: string, ownedHere?: (path: string) => boolean): boolean {
	let marker: { pid?: number; host?: string; boot?: string };
	try {
		marker = JSON.parse(readFileSync(ownerFile(path), "utf8"));
	} catch {
		return false; // no marker (or unreadable) → nobody claims it
	}
	const pid = marker.pid;
	if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
	if (marker.host !== hostname()) return true; // another machine's checkout — never ours to reap
	if (marker.boot !== bootId()) return false; // pre-reboot pid: reuse is near-certain
	// Our OWN pid is not proof: a previous session in this same long-lived process
	// (pi `/new`) leaves markers with this pid, and trusting them made those dirs
	// unreapable for the process lifetime. Callers pass `isLive` for real knowledge.
	if (pid === process.pid) return ownedHere?.(path) ?? true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "EPERM"; // exists, other user
	}
}

/** Stable per-boot id, so a recycled pid from before a reboot can't look alive.
 *  Compute ONE floor on the expressed seconds, not two — separate floors of
 *  walltime and uptime flip by ±1 around integer boundaries and would read a
 *  live marker as dead on a cross-second read. */
function bootId(): string {
	return String(Math.floor((Date.now() - uptime() * 1000) / 1000));
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
	// Unknown registration = every dir might be live. Deleting here would be the
	// single most destructive thing this module can do; bail instead.
	if (!registered) return;
	// Empty run dirs are litter — a run dir holds nothing but its task dirs.
	for (const runDir of readdirSync(sub, { withFileTypes: true })) {
		if (!runDir.isDirectory()) continue;
		const runPath = join(sub, runDir.name);
		try {
			if (readdirSync(runPath).length === 0) rmSync(runPath, { recursive: true, force: true });
		} catch {
			/* skip */
		}
	}
	for (const runDir of readDirs(sub)) {
		for (const taskDir of readDirs(join(sub, runDir))) {
			const dir = join(sub, runDir, taskDir);
			if (registered.some((p) => samePath(p, dir))) continue; // live/registered worktree
			if (ownerAlive(dir)) continue; // claimed by a running session
			rmSync(dir, { recursive: true, force: true });
			rmSync(ownerFile(dir), { force: true });
		}
	}
	prune(root);
}

/** Registered worktree paths, or undefined when the listing failed (see above). */
function worktreePaths(root: string): string[] | undefined {
	const listing = worktreeListing(root);
	return listing?.filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

/** `worktree list --porcelain -z`; `-z` needs git ≥ 2.36, so fall back to the
 *  newline form (which C-quotes exotic paths — those simply won't match, and a
 *  non-match is safe: it only ever means "treat as live"). */
function worktreeListing(root: string): string[] | undefined {
	try {
		return gitRaw(root, ["worktree", "list", "--porcelain", "-z"]).split("\0").filter(Boolean);
	} catch {
		try {
			return git(root, ["worktree", "list", "--porcelain"]).split("\n").filter(Boolean);
		} catch {
			return undefined; // unknown — callers must bail out
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
