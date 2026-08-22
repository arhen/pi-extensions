/**
 * pi-core-subagent — in-process subagents.
 *
 * Fast in-process subagents (isolated AgentSessions, no process spawn).
 * Modes: single / parallel / chain. Background runs, cancel, intercom
 * (ask/notify/update the leader) and agent↔agent mailbox (send/poll).
 *
 * Context discipline: 7 slim parent tools, one-line catalog injected per
 * request (cached), background completions notify with a 3-line summary
 * instead of full outputs, and run updates are throttled (no per-event
 * deep clones).
 *
 * Layout: schemas → schemas.ts, scheduler/graph → graph.ts, rendering →
 * format.ts, run lifecycle → manager.ts, this file = entry + registrations.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { compactLines, formatUsage, makeSummary, statusIcon, taskLine, truncateText } from "./format.ts";
import { waveNotation } from "./graph.ts";
import { cloneRun, SubagentManager } from "./manager.ts";
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
import { repoRoot, sweepStale } from "./worktree.ts";

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager(pi);

	/** Read-only peek: browse agents, enter to tail one. Never mutates run state. */
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
		description: "List subagent runs. `/subagents peek` opens the browsable pane.",
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
						`auto-limit ${next ? "on" : "off"} — ${next ? "leader-imposed" : "no"} maxRuntimeMs caps apply to tasks (off = unlimited until done).`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`auto-limit is ${manager.autoLimitOn ? "on" : "off"} — use \`/subagents auto-limit on|off\` (off = tasks run unlimited until done).`,
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
	// ctrl+shift+s belongs to pi-web-access (search curator); 'a' for agents is free.
	pi.registerShortcut("ctrl+shift+a", { description: "Peek at running subagents", handler: openPeek });

	pi.on("agent_start", (_event, ctx) => {
		if (!manager.turnActivity && !manager.hasActiveRun()) manager.clearWidget(ctx);
		manager.turnActivity = false;
	});

	pi.on("session_start", async (_event, ctx) => {
		await manager.restoreFromSidecar(ctx);
		// Crash leftovers: remove stale worktree dirs (branches survive for merging).
		sweepStale(ctx.cwd);
		for (const run of manager.listRuns()) {
			for (const task of run.tasks) {
				if (task.branch) {
					const root = repoRoot(task.cwd);
					if (root) sweepStale(root);
				}
			}
		}
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx?.hasUI) {
			try {
				ctx.ui.setWidget("subagents", [], { placement: "aboveEditor" });
			} catch {
				/* ignore */
			}
		}
		manager.clearRuns();
	});

	pi.registerTool<typeof SubagentParams, RunDetails>({
		name: "subagent",
		label: "Subagent",
		// ponytail: this string is billed on every request. No example block — an example
		// biases the model toward one shape; guidelines + JSON schema describe all of them.
		description:
			"Run isolated subagents (own context, own session). You invent each agent: name, optional system prompt, toolset (read-only default, write:true to edit). Use `agent`+`task` for one, `tasks` for many. `needs` declares dependency edges: a task waits for its needs and receives their outputs prepended to its prompt. If a user agent file in `.agents/agents`, `.claude/agents`, or `.pi/agents` (project dirs, then home) has a `description` matching the spawn goal (name + task), that file is authoritative: body = system prompt, frontmatter `model`/`tools` apply, inline prompt/model/tools ignored. No match → the inline definition stands. Write agents run in an isolated git worktree: on completion the result reports the branch + changed files — review, then merge with `git merge --no-ff <branch>` (merged branches are cleaned automatically). Every run is background: the call returns a runId immediately and completion notifies you. Set autoAwait:true when you need the result before your next step — the call parks until the run finishes and returns runId + final result in one response. allowIntercom:true lets children talk to you and each other.",
		promptSnippet: "Define and delegate work to specialized subagents.",
		promptGuidelines: [
			"Use subagent when independent review, testing, research, or parallel analysis improves quality.",
			"Put every sub-task in ONE call: subagent({ tasks: [...] }). Never make multiple parallel subagent calls — one call, one run, N tasks.",
			"Order comes from `needs`, not from separate calls: give tasks an `id`, list the ids each depends on. Tasks with no unmet needs run in parallel; dependents receive their upstream outputs automatically — do not restate them.",
			"Prefer flat `tasks` (plain parallel) unless a real dependency exists — only add `needs` edges when ordering genuinely matters.",
			"End each task with a runnable check, e.g. 'Verify: npx tsc --noEmit && bun test'. A subagent's claim of success is not evidence.",
			"For write agents (write:true) in a git repo, the child works in an isolated worktree and its changes are committed to a branch — the result reports branch + changed files. Review the diff, then merge with `git merge --no-ff <branch>`; merged branches are cleaned up automatically. Never leave a worktree branch unmerged at the end of the task.",
			"Define each agent yourself: invented name, focused system prompt, and read-only (default) or write:true. Prefer read-only. A user agent file (`.agents/agents`, `.claude/agents`, `.pi/agents` — project first, then home) whose `description` matches the spawn goal (name + task) takes over: its body is the system prompt, frontmatter `model`/`tools` apply and are validated against the model registry. Matching is by description, not name — name the agent whatever fits the goal.",
			"When you need a run's result before your next step, spawn with autoAwait:true — the call returns runId + final result in one response. Otherwise spawn background and settle results (await_subagent / subagent_result) before continuing dependent work.",
			"For long multi-task runs, don't autoAwait the whole run: spawn background, then loop await_subagent with short timeoutMs slices (e.g. 20s), processing whichever tasks completed in each slice while the rest keep running. You get incremental results instead of one big wait.",
			"allowIntercom:true only when a child may need to ask you something.",
		],
		parameters: SubagentParams,
		executionMode: "parallel", // sibling subagent calls run concurrently, not serialized
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const typed = params as SubagentParamsShape;
			const details = manager.startInBackground(typed, ctx);
			if (typed.autoAwait) {
				// awaitRun wakes on every child→leader message (ask/notify/done) — that's the
				// slice-loop feature. autoAwait wants the final result: re-park until terminal.
				let run = details.run;
				while (!TERMINAL.includes(run.status)) {
					run = (await manager.awaitRun(details.run.id))?.run ?? run;
				}
				return { content: [{ type: "text", text: makeSummary(run) }], details: { run } };
			}
			return {
				content: [
					{
						type: "text",
						text: `Background run started: ${details.run.id} (${details.run.mode}, ${details.run.tasks.length} task${details.run.tasks.length > 1 ? "s" : ""}).\nUse subagent_status / subagent_result / await_subagent / reply_subagent / subagent_cancel to interact.`,
					},
				],
				details,
			};
		},
		renderCall(args, theme) {
			// ponytail: args stream in partially, so mode is unknowable until JSON closes. Show "preparing…" instead of a wrong "single ?".
			const hasEdges = args.tasks?.some((t) => t.needs?.length);
			const mode = args.chain?.length
				? `chain ${args.chain.length}`
				: args.tasks?.length
					? `${hasEdges ? "graph" : "parallel"} ${args.tasks.length}`
					: args.agent
						? `single ${args.agent}`
						: "preparing…";
			const flags = [args.autoAwait ? "await" : "bg", args.allowIntercom ? "a2a" : ""].filter(Boolean).join(" · ");
			// Params used, dimmed: model, thinking, toolset, per-task write count.
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
			// The plan the model actually wrote: ids, edges, toolset. Streams in as args arrive,
			// so a graph is visible before the first child spawns.
			const plan = tasks
				.filter((t) => t.agent || t.id)
				.map((t, i: number) => {
					const id = t.id ?? `task_${i + 1}`;
					const edge = t.needs?.length ? theme.fg("muted", ` ← ${t.needs.join(", ")}`) : "";
					const mark = t.write ? theme.fg("warning", " ✎") : "";
					const meta = [t.model ? t.model : "", t.thinking ? t.thinking : ""].filter(Boolean).join(" ");
					// Plain clip, not truncateText — that one appends a multi-line session-file notice.
					const flat = String(t.task ?? "")
						.replace(/\s+/g, " ")
						.trim();
					const what = flat ? theme.fg("dim", ` ${flat.length > 64 ? `${flat.slice(0, 64)}…` : flat}`) : "";
					return `\n  ${theme.fg("muted", id)} ${theme.fg("accent", t.agent ?? "…")}${mark}${edge}${meta ? ` ${theme.fg("dim", meta)}` : ""}${what}`;
				})
				.join("");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", mode)}${flags ? ` ${theme.fg("muted", `[${flags}]`)}` : ""}${params}${graphLine}${plan}`,
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const run = result.details?.run;
			if (!run) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0);
			// ponytail: mode/count already shown on the call line above; result header only adds progress + status.
			const header = `${statusIcon(run.status)} ${theme.fg("accent", `${run.tasks.filter((t) => t.status === "completed").length}/${run.tasks.length} done`)} ${theme.fg("muted", run.status)}`;
			if (!expanded) {
				// Every run is background: the spawn snapshot is always "0 tools" noise and the footer
				// widget already shows live per-task state — keep the card to the header only.
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
			"Live status of a subagent run (non-blocking): per-task state, plus each child's session file path (JSONL) so you can tail it from outside — e.g. in a terminal multiplexer pane.",
		promptSnippet: "Check progress of a subagent run.",
		parameters: RunIdParam,
		async execute(_id, params) {
			const { runId } = params as { runId: string };
			const run = manager.getRun(runId);
			if (!run) return { content: [{ type: "text", text: `Unknown runId: ${runId}` }], isError: true, details: {} };
			// Session file paths are the one primitive an outside tool needs: `tail -f` it in a
			// multiplexer pane, a log viewer, anything. Cheaper than owning a pane integration.
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
						? `\nBranch: ${t.branch}\n${t.diffStat || "(no changes committed)"}\nMerge after review: \`git merge --no-ff ${t.branch}\``
						: "";
					return `\n## ${t.agent} ${statusIcon(t.status)}\nGoal: ${truncateText(t.task, 300)}\n${t.error ? `Error: ${t.error}` : t.finalText || "(no output yet)"}${wt}\n${formatUsage(t.usage)}`;
				}),
			].join("\n");
			return { content: [{ type: "text", text: truncateText(text) }], details: { run: cloneRun(run) } };
		},
	});

	pi.registerTool<typeof AwaitParam, { run?: RunSnapshot }>({
		name: "await_subagent",
		label: "Await Subagent",
		description:
			"Block until a run finishes (or timeoutMs elapses). While parked, child→leader messages (asks, notifies, completions) wake the wait and arrive INSIDE the result — the await doubles as the run's intercom drain, no steering queue involved.",
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
