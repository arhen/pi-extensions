/** Worktree isolation: create/commit/diff/cleanup against a real temp git repo. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	branchDiff,
	claimWorktree,
	cleanupMerged,
	commitWorktree,
	createWorktree,
	ownerAlive,
	reapDeadWorktrees,
	removeByBranch,
	removeWorktree,
	repoRoot,
	sweepStale,
} from "../src/worktree.ts";

let repo: string;
const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), "wt-repo-"));
	git(["init", "-q", "-b", "main"]);
	writeFileSync(join(repo, "a.txt"), "hello\n");
	git(["add", "-A"]);
	git(["commit", "-qm", "init"]);
});
afterAll(() => {
	rmSync(repo, { recursive: true, force: true });
});

describe("worktree", () => {
	test("repoRoot resolves; non-git dir returns undefined", () => {
		expect(repoRoot(repo)).toBe(realpathSync(repo));
		expect(repoRoot(join(repo, "missing"))).toBeUndefined(); // non-existent dir
		expect(repoRoot(tmpdir())).toBeUndefined();
	});

	test("createWorktree adds a branch + checkout inside .git/subagents", () => {
		const wt = createWorktree(repo, "run_1", "task_1");
		expect(wt).toBeDefined();
		expect(existsSync(join(wt!.path, "a.txt"))).toBe(true);
		expect(git(["branch", "--list", "subagents/run_1/task_1"]).replace(/^\+ /, "")).toBe("subagents/run_1/task_1");
		expect(wt!.base).toBe(git(["rev-parse", "HEAD"])); // SHA, not branch name
		removeWorktree(wt!);
	});

	test("commitWorktree commits child changes; no-op when clean", () => {
		const wt = createWorktree(repo, "run_2", "task_2")!;
		writeFileSync(join(wt.path, "b.txt"), "new\n");
		commitWorktree(wt, "child work");
		expect(git(["log", "--oneline", "-1", wt.branch])).toContain("child work");
		const before = git(["rev-parse", wt.branch]);
		commitWorktree(wt, "noop");
		expect(git(["rev-parse", wt.branch])).toBe(before); // clean → no empty commit
		removeWorktree(wt);
	});

	test("branchDiff reports stat + files vs base", () => {
		const wt = createWorktree(repo, "run_3", "task_3")!;
		writeFileSync(join(wt.path, "c.txt"), "x\n");
		commitWorktree(wt, "third");
		const { stat, files } = branchDiff(wt);
		expect(files).toContain("c.txt");
		expect(stat).toContain("c.txt");
		removeWorktree(wt);
	});

	test("cleanupMerged removes merged worktree dir + branch; unmerged survives", () => {
		const merged = createWorktree(repo, "run_4", "task_4")!;
		writeFileSync(join(merged.path, "d.txt"), "d\n");
		commitWorktree(merged, "to merge");
		git(["merge", "--no-ff", merged.branch, "-m", "merge"]); // leader merges
		removeWorktree(merged); // simulate pre-cleanup state

		const kept = createWorktree(repo, "run_5", "task_5")!;
		writeFileSync(join(kept.path, "e.txt"), "e\n");
		commitWorktree(kept, "keep me");
		removeWorktree(kept);

		const cleaned = cleanupMerged(repo);
		expect(cleaned).toBe(2); // run_1 (empty, tip == main) + run_4 (merged)
		expect(git(["branch", "--list", "subagents/run_4/task_4"])).toBe("");
		expect(git(["branch", "--list", "subagents/run_5/task_5"])).toBe("subagents/run_5/task_5"); // unmerged kept
	});

	test("sweepStale removes dirs of deleted branches, keeps live branches", () => {
		// fake crash leftover: dir without a branch
		const ghost = join(repo, ".git", "subagents", "run_9", "task_9");
		mkdirSync(ghost, { recursive: true });
		writeFileSync(join(ghost, "stale.txt"), "ghost\n");
		sweepStale(repo);
		expect(existsSync(ghost)).toBe(false);
		// live branch dir survives
		const wt = createWorktree(repo, "run_10", "task_10")!;
		writeFileSync(join(wt.path, "f.txt"), "f\n");
		commitWorktree(wt, "live");
		sweepStale(repo);
		expect(existsSync(wt.path)).toBe(true);
		removeWorktree(wt);
	});

	test("cleanupMerged never touches LIVE worktrees (concurrent-run safety)", () => {
		const wt = createWorktree(repo, "run_6", "task_6")!; // fresh: tip == base, looks "merged"
		expect(existsSync(wt.path)).toBe(true);
		const cleaned = cleanupMerged(repo);
		expect(cleaned).toBe(0);
		expect(existsSync(wt.path)).toBe(true); // worktree survives
		expect(git(["branch", "--list", "subagents/run_6/task_6"]).replace(/^\+ /, "")).toBe("subagents/run_6/task_6");
		removeWorktree(wt);
	});

	test("cleanupMerged honors skipBranches (branch owned by a live run)", () => {
		const wt = createWorktree(repo, "run_7", "task_7")!;
		removeWorktree(wt); // not checked out anymore, but the run still owns it
		cleanupMerged(repo, { skipBranches: new Set([wt.branch]) });
		expect(git(["branch", "--list", wt.branch])).toBe(wt.branch); // owned → survives
		cleanupMerged(repo); // unowned now
		expect(git(["branch", "--list", wt.branch])).toBe("");
	});

	test("commitWorktree: untracked node_modules symlink alone is not a commit", () => {
		const wt = createWorktree(repo, "run_8", "task_8")!;
		symlinkSync(join(repo, "a.txt"), join(wt.path, "node_modules")); // stand-in for the dep symlink
		expect(() => commitWorktree(wt, "should be a no-op")).not.toThrow();
		expect(git(["rev-parse", wt.branch])).toBe(git(["rev-parse", "HEAD"])); // no commit created
		removeWorktree(wt);
	});

	test("reapDeadWorktrees commits a crashed child's work, keeps branch, drops dir", () => {
		const wt = createWorktree(repo, "run_12", "task_12")!; // simulates a crash: registered, uncommitted
		writeFileSync(join(wt.path, "crashed.txt"), "half-done\n");
		expect(reapDeadWorktrees(repo)).toBe(1);
		expect(existsSync(wt.path)).toBe(false); // dir gone
		expect(git(["branch", "--list", wt.branch])).toBe(wt.branch); // branch kept
		expect(git(["show", "--name-only", "--format=", wt.branch])).toContain("crashed.txt"); // work survived
	});

	test("sweepStale keeps a live worktree when the repo path contains a space", () => {
		const spaced = mkdtempSync(join(tmpdir(), "wt repo-"));
		const g = (args: string[]) => execFileSync("git", args, { cwd: spaced, encoding: "utf8" }).trim();
		g(["init", "-q", "-b", "main"]);
		writeFileSync(join(spaced, "a.txt"), "hello\n");
		g(["add", "-A"]);
		g(["commit", "-qm", "init"]);
		const wt = createWorktree(spaced, "run_sp", "task_sp")!; // porcelain will C-quote this path
		sweepStale(spaced);
		expect(existsSync(wt.path)).toBe(true); // live checkout must survive
		removeWorktree(wt);
		rmSync(spaced, { recursive: true, force: true });
	});

	test("works when .git is a FILE (repo checked out as a linked worktree)", () => {
		// A worktree of the temp repo: inside it, .git is a file, not a directory.
		const host = createWorktree(repo, "run_host", "task_host")!;
		expect(statSync(join(host.path, ".git")).isFile()).toBe(true);
		const inner = createWorktree(host.path, "run_in", "task_in");
		expect(inner).toBeDefined(); // used to throw → silent in-place fallback
		expect(existsSync(join(inner!.path, "a.txt"))).toBe(true);
		removeWorktree(inner!);
		removeWorktree(host);
	});

	test("ownership marker protects another session's live checkout from reaping", () => {
		const wt = createWorktree(repo, "run_own", "task_own")!;
		claimWorktree(wt);
		expect(ownerAlive(wt.path)).toBe(true); // this pid
		writeFileSync(join(wt.path, "live.txt"), "in progress\n");
		expect(reapDeadWorktrees(repo, ownerAlive)).toBe(0); // owner alive → untouched
		expect(existsSync(wt.path)).toBe(true);
		// Dead owner: marker points at a pid that cannot exist.
		writeFileSync(join(wt.path, ".subagent-owner"), "2147483647");
		expect(ownerAlive(wt.path)).toBe(false);
		expect(reapDeadWorktrees(repo, ownerAlive)).toBe(1);
		expect(existsSync(wt.path)).toBe(false);
		expect(git(["show", "--name-only", "--format=", wt.branch])).toContain("live.txt");
	});

	test("reapDeadWorktrees keeps the dir when the commit fails (work must stay reachable)", () => {
		const wt = createWorktree(repo, "run_lock", "task_lock")!;
		writeFileSync(join(wt.path, "wip.txt"), "unsaved\n");
		// index.lock makes every git write in this worktree fail.
		const lock = join(repo, ".git", "worktrees", "task_lock", "index.lock");
		writeFileSync(lock, "");
		expect(reapDeadWorktrees(repo, ownerAlive)).toBe(0);
		expect(existsSync(wt.path)).toBe(true); // dir survives — work isn't on the branch yet
		rmSync(lock, { force: true });
		expect(reapDeadWorktrees(repo, ownerAlive)).toBe(1); // now it can be committed + dropped
	});

	test("removeByBranch removes the worktree dir by branch name", () => {
		const wt = createWorktree(repo, "run_11", "task_11")!;
		expect(existsSync(wt.path)).toBe(true);
		removeByBranch(repo, wt.branch); // main-tree cwd, like cancelRun passes task.cwd
		expect(existsSync(wt.path)).toBe(false);
		expect(git(["branch", "--list", wt.branch])).toBe(wt.branch); // branch kept
	});
});
