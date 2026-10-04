export const DELEGATE_ARGUMENTS = {
	tasks: [
		{
			agent: "bench-contract-worker",
			task: "Reply with exactly BENCH_OK.",
			prompt: "Your entire response must be BENCH_OK. Do not call tools.",
			write: false,
			tools: [] as string[],
			model: "opencode-go/deepseek-v4.1-flash",
			thinking: "max",
		},
	],
	autoAwait: true,
	notifyPerTask: true,
};

export function controlledArguments(options: { provider: string; model: string; thinking: string }) {
	const args = structuredClone(DELEGATE_ARGUMENTS);
	args.tasks[0]!.model = `${options.provider}/${options.model}`;
	args.tasks[0]!.thinking = options.thinking;
	return args;
}

export function delegationPrompt(args = DELEGATE_ARGUMENTS): string {
	return (
		"Delegate exactly one read-only worker using the exact subagent arguments below, without rewriting them. " +
		"Use the route available to you, including schema/namespace discovery if needed. " +
		"The child result is required in this turn, so autoAwait is intentional. " +
		"After it returns BENCH_OK, end your turn. Do not do the task yourself or modify files.\n" +
		JSON.stringify(args)
	);
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(object)
				.sort()
				.map((key) => [key, canonical(object[key])]),
		);
	}
	return value;
}

export function matchesControlledArguments(preview: string | undefined, expected = DELEGATE_ARGUMENTS): boolean {
	try {
		return JSON.stringify(canonical(JSON.parse(preview ?? ""))) === JSON.stringify(canonical(expected));
	} catch {
		return false;
	}
}
