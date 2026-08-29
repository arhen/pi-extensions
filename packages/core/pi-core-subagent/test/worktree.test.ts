/** Worktree isolation: create/commit/diff/cleanup against a real temp git repo. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
	// CI runners have no global git identity — repo-local config covers every
	// commit/merge in this file (incl. ones inside src/worktree.ts helpers).
	git(["config", "user.name", "test"]);
	git(["config", "user.email", "test@local"]);
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
		g(["config", "user.name", "test"]);
		g(["config", "user.email", "test@local"]);
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

	test("boot-id marker stays stable around a second boundary (no self-misread)", () => {
		// The old two-floor formula (floor(T) - floor(U)) flips by ±1 around integer
		// seconds; the own worktree would read as dead on the very next read.
		const wt = createWorktree(repo, "run_boot", "task_boot")!;
		claimWorktree(wt);
		// Claim, then read twice with a sleep crossing the integer-second line.
		const before = Date.now();
		while (Date.now() - before < 1_100) {
			/* spin past the integer-second boundary */
		}
		expect(ownerAlive(wt.path)).toBe(true); // marker must survive the window
		removeWorktree(wt);
	});

	test("ownership marker protects another session's live checkout from reaping", () => {
		const wt = createWorktree(repo, "run_own", "task_own")!;
		claimWorktree(wt);
		expect(ownerAlive(wt.path)).toBe(true); // this pid
		writeFileSync(join(wt.path, "live.txt"), "in progress\n");
		expect(reapDeadWorktrees(repo, ownerAlive)).toBe(0); // owner alive → untouched
		expect(existsSync(wt.path)).toBe(true);
		// The marker must live BESIDE the checkout, never inside it (it would be committed).
		expect(existsSync(`${wt.path}.owner`)).toBe(true);
		expect(existsSync(join(wt.path, ".subagent-owner"))).toBe(false);
		// Dead owner: same host + boot, pid that cannot exist.
		const marker = JSON.parse(readFileSync(`${wt.path}.owner`, "utf8"));
		writeFileSync(`${wt.path}.owner`, JSON.stringify({ ...marker, pid: 2147483647 }));
		expect(ownerAlive(wt.path)).toBe(false);
		expect(reapDeadWorktrees(repo, ownerAlive)).toBe(1);
		expect(existsSync(wt.path)).toBe(false);
		expect(git(["show", "--name-only", "--format=", wt.branch])).toContain("live.txt");
	});

	test("claimed worktree does not commit its owner marker into the branch", () => {
		const wt = createWorktree(repo, "run_mark", "task_mark")!;
		claimWorktree(wt);
		expect(commitWorktree(wt, "nothing changed")).toBe("empty"); // marker must not count as a change
		writeFileSync(join(wt.path, "real.txt"), "work\n");
		expect(commitWorktree(wt, "real work")).toBe("committed");
		const files = git(["show", "--name-only", "--format=", wt.branch]);
		expect(files).toContain("real.txt");
		expect(files).not.toContain("owner");
		expect(branchDiff(wt).files).toEqual(["real.txt"]);
		removeWorktree(wt);
	});

	test("commitWorktree refuses when the child moved HEAD off the branch", () => {
		const wt = createWorktree(repo, "run_head", "task_head")!;
		writeFileSync(join(wt.path, "x.txt"), "x\n");
		execFileSync("git", ["checkout", "--detach", "-q"], { cwd: wt.path });
		expect(() => commitWorktree(wt, "should refuse")).toThrow(/expected subagents\/run_head\/task_head/);
		removeWorktree(wt);
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

	test("a stacked worktree SEES its upstream's committed work", () => {
		// A chained write task based on main HEAD gets a tree WITHOUT the upstream's
		// edits, so it "builds on" work it cannot see and its merge reverts it.
		const up = createWorktree(repo, "run_stack", "task_a")!;
		writeFileSync(join(up.path, "from-a.txt"), "written by A\n");
		expect(commitWorktree(up, "A's work")).toBe("committed");

		// Downstream stacks on A's branch instead of HEAD.
		const down = createWorktree(repo, "run_stack", "task_b", up.branch)!;
		expect(existsSync(join(down.path, "from-a.txt"))).toBe(true);
		expect(readFileSync(join(down.path, "from-a.txt"), "utf8")).toBe("written by A\n");

		// B's own diff is against its own base, so it reports only B's files.
		writeFileSync(join(down.path, "from-b.txt"), "written by B\n");
		expect(commitWorktree(down, "B's work")).toBe("committed");
		expect(branchDiff(down).files).toEqual(["from-b.txt"]);

		// A sibling (no baseRef) must NOT see A's work — siblings stay independent.
		const sib = createWorktree(repo, "run_stack", "task_c")!;
		expect(existsSync(join(sib.path, "from-a.txt"))).toBe(false);

		removeWorktree(sib);
		removeWorktree(down);
		removeWorktree(up);
	});

	test("a vanished upstream ref falls back to HEAD instead of failing", () => {
		const wt = createWorktree(repo, "run_ghost", "task_ghost", "subagents/does/not-exist");
		expect(wt).toBeDefined();
		expect(existsSync(wt!.path)).toBe(true);
		removeWorktree(wt!);
	});

	test("removeByBranch removes the worktree dir by branch name", () => {
		const wt = createWorktree(repo, "run_11", "task_11")!;
		expect(existsSync(wt.path)).toBe(true);
		removeByBranch(repo, wt.branch); // main-tree cwd, like cancelRun passes task.cwd
		expect(existsSync(wt.path)).toBe(false);
		expect(git(["branch", "--list", wt.branch])).toBe(wt.branch); // branch kept
	});
});
