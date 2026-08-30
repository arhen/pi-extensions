import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { compactLines, formatUsage, makeSummary, statusIcon, taskLine, truncateText } from "./format.ts";
import { waveNotation } from "./graph.ts";
import { cloneRun, type ParkedMsg, SubagentManager } from "./manager.ts";
import { createPeekPane, type PeekTask } from "./peek.ts";
import {
	AwaitParam,
	ReplyParam,
	ResultParam,
	RunIdParam,
	SteerParam,
	SubagentParams,
	type SubagentParamsShape,
} from "./schemas.ts";
import { type RunDetails, type RunSnapshot, TERMINAL } from "./types.ts";
import { cleanupMerged, ownerAlive, reapDeadWorktrees, repoRoot, sweepStale } from "./worktree.ts";

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager(pi);

	const openPeek = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const getTasks = (): PeekTask[] =>
			manager
				.listRuns()
				.flatMap((run) => run.tasks)
				.map((task) => ({
					runId: task.runId,
					taskId: task.id,
					agent: task.agent,
					status: task.status,
					running: !TERMINAL.includes(task.status),
					sessionFile: task.sessionFile,
					line: taskLine(task),
				}));
		if (getTasks().length === 0) {
			ctx.ui.notify("No subagents in this session.", "info");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				createPeekPane(
					getTasks,
					theme,
					() => tui.requestRender(),
					() => done(undefined),
					(t) => {
						if (manager.cancelTask(t.runId, t.taskId, ctx)) ctx.ui.notify(`Aborted subagent ${t.agent}.`, "warning");
					},
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "70%", margin: 2 } },
		);
	};
	pi.registerCommand("subagents", {
		description:
			"List subagent runs. `/subagents peek` opens the browsable pane; `/subagents auto-limit on|off` toggles the 1 h default runtime ceiling (default off = 6 h).",
		handler: async (args, ctx) => {
			const arg = String(args ?? "")
				.trim()
				.toLowerCase();
			if (arg === "peek") return openPeek(ctx);
			if (arg === "auto-limit" || arg.startsWith("auto-limit ")) {
				const value = arg.split(/\s+/)[1];
				if (value === "on" || value === "off") {
					const next = manager.setAutoLimit(value === "on");
					ctx.ui.notify(
						`auto-limit ${next ? "on" : "off"} — ${next ? "tasks without an explicit maxRuntimeMs get the 1 h default ceiling" : "raised 6 h ceiling applies (no 1 h cap)"}.`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`auto-limit is ${manager.autoLimitOn ? "on (1 h default ceiling)" : "off (6 h ceiling)"} — use \`/subagents auto-limit on|off\`.`,
						"info",
					);
				}
				return;
			}
			const runs = manager.listRuns().slice(0, 10);
			if (runs.length === 0) {
				ctx.ui.notify("No subagent runs in this session.", "info");
				return;
			}
			ctx.ui.notify(runs.flatMap((run) => compactLines(run).concat("")).join("\n"), "info");
		},
	});

	pi.registerShortcut("ctrl+shift+a", { description: "Peek at running subagents", handler: openPeek });

	pi.on("agent_start", (_event, ctx) => {
		if (!manager.turnActivity && !manager.hasActiveRun()) manager.clearWidget(ctx);
		manager.turnActivity = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		await manager.restoreFromSidecar(ctx);

		const roots = new Set<string>();
		const cwdRoot = repoRoot(ctx.cwd);
		if (cwdRoot) roots.add(cwdRoot);
		for (const run of manager.listRuns()) {
			for (const task of run.tasks) {
				if (task.branch) {
					const root = repoRoot(task.cwd);
					if (root) roots.add(root);
				}
			}
		}
		for (const root of roots) {
			try {
				reapDeadWorktrees(root, (p) => ownerAlive(p, manager.ownsWorktree));
				cleanupMerged(root, { skipBranches: manager.liveBranches() });
				sweepStale(root);
			} catch {}
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx?.hasUI) {
			try {
				ctx.ui.setWidget("subagents", [], { placement: "aboveEditor" });
			} catch {}
		}
		manager.clearRuns();
	});

	pi.registerTool<typeof SubagentParams, RunDetails>({
		name: "subagent",
		label: "Subagent",

		description:
			"Run isolated subagents (own context, own session). You invent each agent: name, optional system prompt, toolset (read-only default, write:true to edit). Use `agent`+`task` for one, `tasks` for many. `needs` declares dependency edges: a task waits for its needs and receives their outputs prepended to its prompt. If a user agent file in `.agents/agents`, `.claude/agents`, or `.pi/agents` (project dirs, then home) has a `description` matching the spawn goal (name + task), that file is authoritative: body = system prompt, frontmatter `model`/`tools` apply and inline prompt/model are ignored — except explicit per-call `tools`/`write`, which override the file's tools. No match → the inline definition stands. Write agents run in an isolated git worktree: on completion the result reports the branch + changed files — review, then merge with `git merge --no-ff <branch>` (merged branches are cleaned automatically). Every run is background: the call returns a runId immediately and completion notifies you — do NOT park waiting on it. If you have no other work, end your turn; the completion notice wakes you with the results. Set autoAwait:true only when the very next step in the SAME turn consumes the result. Children always carry talk tools: they can ask you questions, notify you, and message siblings.",
		promptSnippet: "Define and delegate work to specialized subagents.",
		promptGuidelines: [
			"Use subagent when independent review, testing, research, or parallel analysis improves quality.",
			"Put every sub-task in ONE call: subagent({ tasks: [...] }). Never make multiple parallel subagent calls — one call, one run, N tasks.",
			"Order comes from `needs`, not from separate calls: give tasks an `id`, list the ids each depends on. Tasks with no unmet needs run in parallel; dependents receive their upstream outputs automatically — do not restate them.",
			"Prefer flat `tasks` (plain parallel) unless a real dependency exists — only add `needs` edges when ordering genuinely matters.",
			"End each task with a runnable check, e.g. 'Verify: npx tsc --noEmit && bun test'. A subagent's claim of success is not evidence.",
			"For write agents (write:true) in a git repo, the child works in an isolated worktree and its changes are committed to a branch — the result reports branch + changed files. Review the diff, then merge with `git merge --no-ff <branch>`; merged branches are cleaned up automatically. Never leave a worktree branch unmerged at the end of the task.",
			"Define each agent yourself: invented name, focused system prompt, and read-only (default) or write:true. Prefer read-only. A user agent file (`.agents/agents`, `.claude/agents`, `.pi/agents` — project first, then home) whose `description` matches the spawn goal (name + task) takes over: its body is the system prompt, frontmatter `model`/`tools` apply and are validated against the model registry — explicit per-call `tools`/`write` still override the file's tools. Matching is by description, not name — name the agent whatever fits the goal.",
			"Right after a background spawn, call subagent_status(runId) ONCE before any other work — confirm each task is running (or already progressing), not stuck queued or failed at startup. A child that dies on spawn otherwise stays invisible until far later.",
			"If that first status shows a task failed or never started, fix or respawn immediately; do not move on assuming it runs.",
			"Never block with nothing to do: if you have no work left after spawning, end your turn. Task completion notifies you and wakes a fresh turn with the results — await_subagent/autoAwait in that situation only burns time and tokens.",
			"autoAwait:true only when the same turn must consume the result immediately (e.g. you spawn a reviewer and then must act on its verdict before replying). Otherwise spawn background and read results from the completion notice, or subagent_result when you come back.",
			"await_subagent is for the rare case where you have parallel work of your own and need to sync at a specific point — not the default follow-up to a spawn.",
		],
		parameters: SubagentParams,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed = params as SubagentParamsShape;
			const details = manager.startInBackground(typed, ctx);
			if (typed.autoAwait) {
				let run = details.run;

				const intercom: ParkedMsg[] = [];
				while (!TERMINAL.includes(run.status)) {
					const awaited = await manager.awaitRun(details.run.id);
					if (!awaited) break;
					if (awaited.run) run = awaited.run;
					intercom.push(...awaited.intercom);
					if (awaited.intercom.some((m) => m.kind === "ask")) break;
				}

				const asks = intercom.filter((m) => m.kind === "ask");
				const heard = intercom.filter((m) => m.kind !== "ask");
				const text = [
					makeSummary(run),
					heard.length > 0
						? `\nIntercom while waiting:\n${heard.map((m) => `- [${m.kind}] ${m.agent} (${m.taskId}): ${truncateText(m.text)}`).join("\n")}`
						: "",
					asks.length > 0
						? `\n${asks.length} child(ren) waiting for your answer:\n${asks
								.map(
									(a) =>
										`- ${a.agent} (${a.taskId}): ${a.text}\n  reply_subagent(runId: "${run.id}", taskId: "${a.taskId}", message: ...)`,
								)
								.join("\n")}\nAnswer each, then await_subagent again for the result.`
						: "",
				]
					.filter(Boolean)
					.join("\n");
				return { content: [{ type: "text", text }], details: { run } };
			}
			return {
				content: [
					{
						type: "text",
						text: `Background run started: ${details.run.id} (${details.run.mode}, ${details.run.tasks.length} task${details.run.tasks.length > 1 ? "s" : ""}).\nNext: call subagent_status("${details.run.id}") now to confirm the tasks actually started before doing anything else.\nAfter that, completion will notify you — if you have no other work, end your turn instead of waiting.\nOther tools: subagent_result / reply_subagent / steer_subagent / subagent_cancel.`,
					},
				],
				details,
			};
		},
		renderCall(args, theme) {
			const hasEdges = args.tasks?.some((t) => t.needs?.length);
			const mode = args.chain?.length
				? `chain ${args.chain.length}`
				: args.tasks?.length
					? `${hasEdges ? "graph" : "parallel"} ${args.tasks.length}`
					: args.agent
						? `single ${args.agent}`
						: "preparing…";
			const flags = args.autoAwait ? "await" : "bg";

			const tasks = args.tasks ?? args.chain ?? [];
			const writeCount = tasks.filter((t) => t.write).length;
			const parts: string[] = [];
			if (args.model) parts.push(args.model);
			if (args.thinking) parts.push(args.thinking);
			if (args.write) parts.push("can edit");
			if (writeCount > 0) parts.push(`${writeCount} can edit`);
			if (args.concurrency) parts.push(`${args.concurrency} at a time`);
			if (args.maxRuntimeMs) parts.push(`${Math.round(args.maxRuntimeMs / 60000)}m limit`);
			const params = parts.length > 0 ? `\n  ${theme.fg("dim", parts.join(" · "))}` : "";
			const notation = waveNotation(tasks);
			const graphLine = notation ? `\n  ${theme.fg("muted", notation)}` : "";

			const plan = tasks
				.filter((t) => t.agent || t.id)
				.map((t, i: number) => {
					const id = t.id ?? `task_${i + 1}`;
					const edge = t.needs?.length ? theme.fg("muted", ` ← ${t.needs.join(", ")}`) : "";
					const mark = t.write ? theme.fg("warning", " ✎") : "";
					const meta = [t.model ? t.model : "", t.thinking ? t.thinking : ""].filter(Boolean).join(" ");

					const flat = String(t.task ?? "")
						.replace(/\s+/g, " ")
						.trim();
					const what = flat ? theme.fg("dim", ` ${flat.length > 64 ? `${flat.slice(0, 64)}…` : flat}`) : "";
					return `\n  ${theme.fg("muted", id)} ${theme.fg("accent", t.agent ?? "…")}${mark}${edge}${meta ? ` ${theme.fg("dim", meta)}` : ""}${what}`;
				})
				.join("");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)} ${theme.fg("muted", `[${flags}]`)}${params}${graphLine}${plan}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const run = result.details?.run;
			if (!run) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);

			const header = `${statusIcon(run.status)} ${theme.fg("accent", `${run.tasks.filter((t) => t.status === "completed").length}/${run.tasks.length} done`)} ${theme.fg("muted", run.status)}`;
			if (!expanded) {
				const usage = formatUsage(run.aggregateUsage);
				return new Text(usage ? `${header}\n${theme.fg("dim", usage)}` : header, 0, 0);
			}
			const lines = [header];
			for (const task of run.tasks) {
				lines.push(
					`  ${statusIcon(task.status)} ${theme.fg("accent", task.agent)}${task.sessionId ? ` ${theme.fg("muted", task.sessionId)}` : ""}`,
				);
				if (task.error) lines.push(`    ${theme.fg("error", task.error)}`);
				else if (task.finalText) lines.push(`    ${truncateToWidth(theme.fg("dim", task.finalText.trim()), 120, "…")}`);
				const usage = formatUsage(task.usage);
				if (usage) lines.push(`    ${theme.fg("dim", usage)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool<typeof RunIdParam, { run?: RunSnapshot }>({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Live status of a subagent run (non-blocking): per-task state, plus each child's session file path (JSONL) so you can tail it from outside — e.g. in a terminal multiplexer pane. Call this once right after spawning to verify the children actually started.",
		promptSnippet: "Check progress of a subagent run; use right after spawn as a health check.",
		promptGuidelines: [
			"Health-check every background spawn with one subagent_status(runId) before continuing — catch dead-on-arrival children early instead of at completion time.",
		],
		parameters: RunIdParam,
		async execute(_id, params) {
			const { runId } = params as { runId: string };
			const run = manager.getRun(runId);
			if (!run) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };

			const files = run.tasks.filter((t) => t.sessionFile).map((t) => `${t.id} (${t.agent}): ${t.sessionFile}`);
			const text = [
				compactLines(run).join("\n"),
				...(files.length > 0 ? ["", "Live session files (tail -f to watch):", ...files] : []),
			].join("\n");
			return { content: [{ type: "text", text }], details: { run: cloneRun(run) } };
		},
	});

	pi.registerTool<typeof ResultParam, { run?: RunSnapshot }>({
		name: "subagent_result",
		label: "Subagent Result",
		description: "Full result (finalText + usage) of a run or one task. Non-blocking.",
		parameters: ResultParam,
		async execute(_id, params) {
			const { runId, taskId } = params as { runId: string; taskId?: string };
			const run = manager.getRun(runId);
			if (!run) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			const tasks = taskId ? run.tasks.filter((t) => t.id === taskId) : run.tasks;
			const text = [
				`Run ${run.id} — ${run.status}`,
				...tasks.map((t) => {
					const wt = t.branch
						? `\nBranch: ${t.branch}\n${t.diffStat || "(no diff available)"}\nMerge after review: \`git merge --no-ff ${t.branch}\``
						: t.isolation === "in-place"
							? `\nApplied IN PLACE (no branch) — ${t.isolationReason ?? "worktree unavailable"}. The changes are already in your working tree.`
							: "";
					const wtErr = t.worktreeError ? `\nWorktree: ${t.worktreeError}` : "";
					return `\n## ${t.agent} ${statusIcon(t.status)}\nGoal: ${truncateText(t.task, 300)}\n${t.error ? `Error: ${t.error}` : t.finalText || "(no output yet)"}${wt}${wtErr}\n${formatUsage(t.usage)}`;
				}),
			].join("\n");
			return { content: [{ type: "text", text: truncateText(text) }], details: { run: cloneRun(run) } };
		},
	});

	pi.registerTool<typeof AwaitParam, { run?: RunSnapshot }>({
		name: "await_subagent",
		label: "Await Subagent",
		description:
			"Block until a run finishes (or timeoutMs elapses). Use ONLY when you have work of your own to sync with; if you have nothing else to do, end your turn instead — completion notifies you and wakes a new turn with the results. While parked, child→leader messages (asks, notifies, completions) wake the wait and arrive INSIDE the result.",
		promptGuidelines: [
			"Do not call await_subagent right after spawning with no other work pending — end the turn and let the completion notice wake you.",
		],
		parameters: AwaitParam,
		async execute(_id, params) {
			const { runId, timeoutMs } = params as { runId: string; timeoutMs?: number };
			const awaited = await manager.awaitRun(runId, timeoutMs);
			if (!awaited) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			const { run, intercom } = awaited;
			if (!run) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			const intercomText =
				intercom.length > 0
					? `\n\nIntercom while waiting:\n${intercom
							.map((m) => `- [${m.kind}] ${m.agent} (${m.taskId}): ${truncateText(m.text)}`)
							.join("\n")}`
					: "";
			return { content: [{ type: "text", text: makeSummary(run) + intercomText }], details: { run } };
		},
	});

	pi.registerTool<typeof ReplyParam, { run?: RunSnapshot }>({
		name: "reply_subagent",
		label: "Reply Subagent",
		description: "Answer a child's ask_parent question; resumes its run.",
		parameters: ReplyParam,
		async execute(_id, params) {
			const { runId, taskId, message } = params as { runId: string; taskId: string; message: string };
			const ok = manager.deliverReply(runId, taskId, message);
			if (!ok)
				return {
					content: [{ type: "text", text: `No pending question for ${runId}/${taskId}.` }],
					isError: true,
					details: {},
				};
			return {
				content: [{ type: "text", text: `Reply delivered to ${runId}/${taskId}. The child will resume.` }],
				details: {},
			};
		},
	});

	pi.registerTool<typeof SteerParam, { steered?: string[] }>({
		name: "steer_subagent",
		label: "Steer Subagent",
		description:
			"Inject a steering message into a running subagent's session (queues as steer if the child is mid-turn; delivered at its next model boundary).",
		parameters: SteerParam,
		async execute(_id, params) {
			const { runId, taskId, message } = params as { runId: string; taskId?: string; message: string };
			const ok = manager.steerTask(runId, taskId, message);
			if (!ok)
				return {
					content: [{ type: "text", text: `No running task(s) for ${runId}${taskId ? `/${taskId}` : ""}.` }],
					isError: true,
					details: {},
				};
			return {
				content: [
					{
						type: "text",
						text: `Steering message queued for ${runId}${taskId ? `/${taskId}` : " (all running tasks)"}.`,
					},
				],
				details: {},
			};
		},
	});

	pi.registerTool<typeof RunIdParam, { aborted?: number }>({
		name: "subagent_cancel",
		label: "Subagent Cancel",
		description: "Abort a running/queued subagent run. Children are killed; run becomes aborted.",
		promptSnippet: "Cancel a subagent run.",
		parameters: RunIdParam,
		async execute(_id, params) {
			const { runId } = params as { runId: string };
			const { aborted } = manager.cancelRun(runId);
			if (aborted === 0 && !manager.getRun(runId))
				return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			return {
				content: [{ type: "text", text: `Canceled ${aborted} task${aborted === 1 ? "" : "s"} in run ${runId}.` }],
				details: { aborted },
			};
		},
	});
}
