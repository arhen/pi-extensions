import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import {
	compactLines,
	formatUsage,
	makeSummary,
	renderModelCatalog,
	statusIcon,
	taskLine,
	truncateText,
} from "./format.ts";
import { waveNotation } from "./graph.ts";
import { cloneRun, type ParkedMsg, SubagentManager } from "./manager.ts";
import { listSelectableModels } from "./models.ts";
import { createPeekPane, type PeekTask } from "./peek.ts";
import { type AnyToolDefinition, createPresentation, isSubagentMode } from "./presentation.ts";
import {
	AwaitParam,
	ModelsParam,
	ReplyParam,
	ResultParam,
	ResumeParam,
	RunIdParam,
	SteerParam,
	SubagentParams,
	type SubagentParamsShape,
} from "./schemas.ts";
import { type ModelCatalog, type RunDetails, type RunSnapshot, TERMINAL } from "./types.ts";
import { cleanupMerged, ownerAlive, reapDeadWorktrees, repoRoot, sweepStale } from "./worktree.ts";

export default function (pi: ExtensionAPI) {
	const manager = new SubagentManager(pi);
	const definitions: AnyToolDefinition[] = [];
	const presentation = createPresentation(pi, definitions);
	const defineTool = <TParams extends TSchema, TDetails = unknown, TState = any>(
		definition: ToolDefinition<TParams, TDetails, TState>,
	): void => {
		definitions.push(definition as AnyToolDefinition);
	};

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
			"List subagent runs. `/subagents peek` opens the browsable pane; `/subagents mode [auto|direct|codemode]` reports or switches the tool exposure profile; `/subagents auto-limit on|off` toggles the 1 h default runtime ceiling (default off = 6 h).",
		handler: async (args, ctx) => {
			const arg = String(args ?? "")
				.trim()
				.toLowerCase();
			if (arg === "mode" || arg.startsWith("mode ")) {
				const value = arg.split(/\s+/)[1];
				if (value === undefined) {
					ctx.ui.notify(presentation.describe(), "info");
				} else if (isSubagentMode(value)) {
					presentation.setPreference(value);
					// A switch during a streaming turn or an executing script would rewrite the loadout under
					// a live call; defer it to the next request boundary in that case.
					const idle = typeof ctx.isIdle === "function" ? ctx.isIdle() : true;
					if (idle) presentation.sync();
					ctx.ui.notify(
						`Subagent exposure mode set to ${value}${idle ? "." : " — applies at the next request boundary."} ${presentation.describe()}`,
						"info",
					);
				} else {
					ctx.ui.notify(`Unknown subagent mode "${value}". Use \`/subagents mode auto|direct|codemode\`.`, "warning");
				}
				return;
			}
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

	pi.on("before_agent_start", () => {
		presentation.sync();
	});
	// Successive model turns of the same run are safe boundaries too: a codemode availability or
	// helper-selection change made between turns must reach the next request without a new prompt.
	pi.on("turn_start", () => {
		presentation.sync();
	});

	pi.on("session_start", async (_event, ctx) => {
		await manager.restoreFromSidecar(ctx);
		presentation.restore(ctx);
		presentation.sync();

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
	pi.on("session_tree", (_event, ctx) => {
		presentation.restore(ctx);
		presentation.sync();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx?.hasUI) {
			try {
				ctx.ui.setWidget("subagents", [], { placement: "aboveEditor" });
			} catch {}
		}
		manager.clearRuns();
	});

	defineTool<typeof ModelsParam, ModelCatalog>({
		name: "subagent_models",
		label: "Subagent Models",
		description:
			"List the models a subagent task may name: the exact `model` value to pass, the thinking levels the runtime honors, the context window and catalog price. Scoped to this session's models when scoping is configured, else every usable model; ambiguous references are called out. Full reference: `describeNamespace('subagents')`.",
		promptSnippet: "List the models a subagent task can name (reference, thinking levels, context, price).",
		parameters: ModelsParam,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return renderModelCatalog(listSelectableModels(ctx));
		},
	});

	defineTool<typeof SubagentParams, RunDetails>({
		name: "subagent",
		label: "Subagent",

		description:
			"Run isolated subagents (own context/session) in the background; returns a runId and completion notifies you. One call = one agent (`agent`+`task`) or many (`tasks`, `chain`, or `needs` edges that gate tasks and prepend upstream output). Write tasks use an isolated git worktree and report a branch; a matching agent file is authoritative (matched by description, body/model win). Full reference: `describeNamespace('subagents')`.",
		promptSnippet: "Define and delegate work to specialized subagents.",
		promptGuidelines: [
			"`model` is optional: omit it to inherit your current session model, or name one (agent-file `model` frontmatter wins) to pin the run. Call subagent_models for the exact references, thinking levels, and prices this session may use.",
			"Use subagent for independent review, testing, research or parallel analysis; skip it when one direct action finishes the job.",
			"Batch every sub-task in ONE call: subagent({ tasks: [...] }) — never multiple parallel subagent calls; declare ordering with `needs` edges, not separate calls.",
			"Define each agent inline: invented name, focused system prompt, read-only by default (write:true to edit). Agent files are matched by description/goal, not name; a match is authoritative (body/model), and only per-call tools/write override its tools.",
			"Write agents work in an isolated git worktree; review the branch diff and merge with `git merge --no-ff <branch>` when done.",
			"After spawning, call subagent_status({ runId }) ONCE to confirm the tasks started; fix or respawn a task that died on spawn.",
			"End each task with a runnable check, e.g. 'Verify: bun test'. A subagent's claim of success is not evidence.",
			"When you have no work left, end your turn — completion notifies you. await_subagent/autoAwait only when this turn must consume the result immediately.",
			"A failed task keeps its session file and branch: resume_subagent({ runId, taskId }) revives it; respawn only when it never started.",
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
										`- ${a.agent} (${a.taskId}): ${a.text}\n  reply_subagent({ runId: "${run.id}", taskId: "${a.taskId}", message: ... })`,
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
						text: `Background run started: ${details.run.id} (${details.run.mode}, ${details.run.tasks.length} task${details.run.tasks.length > 1 ? "s" : ""}).\nNext: call subagent_status({ runId: "${details.run.id}" }) now to confirm the tasks actually started before doing anything else.\nAfter that, completion will notify you — if you have no other work, end your turn instead of waiting.\nOther tools: subagent_result / reply_subagent / steer_subagent / resume_subagent / subagent_cancel.`,
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

	defineTool<typeof RunIdParam, { run?: RunSnapshot }>({
		name: "subagent_status",
		label: "Subagent Status",
		description:
			"Live per-task status of a subagent run (non-blocking), incl. each child's session file path to `tail -f`. Call once right after spawning to verify children actually started.",
		promptSnippet: "Check progress of a subagent run; use right after spawn as a health check.",
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

	defineTool<typeof ResultParam, { run?: RunSnapshot }>({
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
					const modelNote = t.modelNote ? `\nModel: ${t.modelNote}` : "";
					return `\n## ${t.agent} ${statusIcon(t.status)}\nGoal: ${truncateText(t.task, 300)}\n${t.error ? `Error: ${t.error}` : t.finalText || "(no output yet)"}${wt}${wtErr}${modelNote}\n${formatUsage(t.usage)}`;
				}),
			].join("\n");
			return { content: [{ type: "text", text: truncateText(text) }], details: { run: cloneRun(run) } };
		},
	});

	defineTool<typeof AwaitParam, { run?: RunSnapshot }>({
		name: "await_subagent",
		label: "Await Subagent",
		description:
			"Block until a run finishes (or timeoutMs elapses). Only when you have your own work to sync; otherwise end your turn. Child messages that arrive while parked wake the wait and are returned.",
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

	defineTool<typeof ReplyParam, { run?: RunSnapshot }>({
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

	defineTool<typeof SteerParam, { steered?: string[] }>({
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

	defineTool<typeof ResumeParam, { run?: RunSnapshot }>({
		name: "resume_subagent",
		label: "Resume Subagent",
		description:
			"Revive a failed/aborted task in its original session (full context + worktree branch preserved). Optional `model` swaps provider after e.g. a rate limit; `thinking` is clamped to the target model; `message` replaces the default recap prompt. Refuses tasks that never started — respawn those.",
		parameters: ResumeParam,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { runId, taskId, message, model, thinking } = params as {
				runId: string;
				taskId: string;
				message?: string;
				model?: string;
				thinking?: string;
			};
			const res = manager.resumeTask(runId, taskId, ctx, { message, model, thinking });
			if (!res.ok) return { content: [{ type: "text", text: res.reason }], isError: true, details: {} };
			const run = manager.getRun(runId);
			return {
				content: [
					{
						type: "text",
						text: `Resumed ${runId}/${taskId} (${res.task.agent})${model ? ` on ${model}` : ""} from ${res.task.sessionFile}${res.task.branch ? `, branch ${res.task.branch}` : ""}.${res.note ? ` Adjusted ${res.note}.` : ""}\nNext: subagent_status({ runId: "${runId}" }) to confirm it is running; completion will notify you.`,
					},
				],
				details: { run: run ? cloneRun(run) : undefined },
			};
		},
	});

	defineTool<typeof RunIdParam, { aborted?: number }>({
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

	presentation.registerInitial();
}
