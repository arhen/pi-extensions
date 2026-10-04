import type { CapturedTool, ExtensionHarness, LoadoutView } from "../parity/harness.ts";

export interface SimulatedLoadout {
	declared: CapturedTool[];
	hidden: Set<string>;
	callable: CapturedTool[];
}

/** Tools callable through ctx.executeTool(): codemode/deferred always, direct while active. */
export function callableTools(h: ExtensionHarness, active: string[] = h.activeTools): CapturedTool[] {
	return [...h.tools.values()].filter((tool) => {
		const exposure = tool.exposure ?? "direct";
		return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.includes(tool.name));
	});
}

/**
 * Mirrors AgentSession._applyToolLoadout for the presentation contract: active tools whose
 * prepareLoadout hooks return hiddenDeclarations stay active and callable but leave requests.
 */
export function simulateLoadout(h: ExtensionHarness, active: string[] = h.activeTools): SimulatedLoadout {
	// Names without a captured definition (built-ins such as read/codemode) keep their placeholder
	// so the hook sees the same declared names Pi would pass.
	const activeTools = active.map((name) => h.tools.get(name) ?? ({ name } as CapturedTool));
	const registered = [...h.tools.values()];
	const view: LoadoutView = {
		declared: activeTools,
		callable: callableTools(h, active),
		registered,
		getExposure: (name) => h.tools.get(name)?.exposure ?? "direct",
		getNamespace: (name) => h.tools.get(name)?.namespace,
	};
	const hidden = new Set<string>();
	for (const tool of activeTools) {
		for (const name of tool.prepareLoadout?.(view)?.hiddenDeclarations ?? []) hidden.add(name);
	}
	return { declared: activeTools.filter((tool) => !hidden.has(tool.name)), hidden, callable: view.callable };
}
