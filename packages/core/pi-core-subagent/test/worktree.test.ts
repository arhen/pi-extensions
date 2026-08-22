/** Worktree isolation: create/commit/diff/cleanup against a real temp git repo. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	branchDiff,
	cleanupMerged,
	commitWorktree,
	createWorktree,
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

	test("removeByBranch removes the worktree dir by branch name", () => {
		const wt = createWorktree(repo, "run_11", "task_11")!;
		expect(existsSync(wt.path)).toBe(true);
		removeByBranch(repo, wt.branch); // main-tree cwd, like cancelRun passes task.cwd
		expect(existsSync(wt.path)).toBe(false);
		expect(git(["branch", "--list", wt.branch])).toBe(wt.branch); // branch kept
	});
});
