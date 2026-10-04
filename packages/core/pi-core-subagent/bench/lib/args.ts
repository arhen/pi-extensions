import { homedir } from "node:os";
import { controlledArguments, delegationPrompt } from "./contract.ts";

export type Workflow = "startup" | "delegate" | "all";
export type BenchMode = "baseline" | "direct" | "codemode" | "auto";
export type CodemodeState = "active" | "on" | "only" | "disabled";
export type ModelRefresh = "offline" | "network";

export interface BenchOptions {
	workflow: Workflow;
	samples: number;
	target: string | undefined;
	mode: BenchMode;
	codemode: CodemodeState;
	out: string | undefined;
	compareTo: string | undefined;
	cwd: string;
	agentDir: string | undefined;
	provider: string;
	model: string;
	thinking: string;
	modelRefresh: ModelRefresh;
	coldNonce: boolean;
	modeCommand: string;
	codemodeCommand: string;
	settleTimeoutMs: number;
	childTimeoutMs: number;
	dryRun: boolean;
	selfTest: boolean;
	help: boolean;
	verbose: boolean;
	allowMissingModeCommand: boolean;
	startupPrompt: string;
	delegatePrompt: string;
}

export const DEFAULTS = {
	workflow: "all",
	samples: 3,
	mode: "baseline",
	codemode: "active",
	provider: "opencode-go",
	model: "deepseek-v4.1-flash",
	thinking: "max",
	modelRefresh: "offline",
	coldNonce: false,
	modeCommand: "/subagents mode {mode}",
	codemodeCommand: "",
	settleTimeoutMs: 180_000,
	childTimeoutMs: 180_000,
	startupPrompt: "hi",
	delegatePrompt: delegationPrompt(),
} as const;

const WORKFLOWS: Workflow[] = ["startup", "delegate", "all"];
const MODES: BenchMode[] = ["baseline", "direct", "codemode", "auto"];
const CODEMODE_STATES: CodemodeState[] = ["active", "on", "only", "disabled"];
const REFRESH_MODES: ModelRefresh[] = ["offline", "network"];

export class UsageError extends Error {}

function require(cond: boolean, message: string): void {
	if (!cond) throw new UsageError(message);
}

function parseOneOf<T extends string>(flag: string, raw: string, allowed: readonly T[]): T {
	const value = raw.trim().toLowerCase();
	require(allowed.includes(value as T), `${flag} must be one of ${allowed.join("|")} (got "${raw}")`);
	return value as T;
}

function parseIntFlag(flag: string, raw: string): number {
	const value = Number.parseInt(raw, 10);
	require(Number.isFinite(value) && value > 0, `${flag} must be a positive integer (got "${raw}")`);
	return value;
}

export function parseArgs(argv: string[]): Partial<BenchOptions> & { help: boolean; _: string[] } {
	const out: Partial<BenchOptions> & { help: boolean; _: string[] } = {
		help: false,
		_: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--") {
			out._.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-") || arg === "-") {
			out._.push(arg);
			continue;
		}
		const eq = arg.indexOf("=");
		const flag = (eq >= 0 ? arg.slice(0, eq) : arg).trim();
		const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
		const next = (): string => {
			if (inline !== undefined) return inline;
			const value = argv[++i];
			require(value !== undefined, `missing value for ${flag}`);
			return value as string;
		};
		const bool = (): boolean => (inline === undefined ? true : inline !== "false" && inline !== "0");
		switch (flag) {
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--workflow":
			case "-w":
				out.workflow = parseOneOf(flag, next(), WORKFLOWS);
				break;
			case "--samples":
			case "-n":
				out.samples = parseIntFlag(flag, next());
				break;
			case "--target":
			case "-t":
				out.target = next();
				break;
			case "--mode":
				out.mode = parseOneOf(flag, next(), MODES);
				break;
			case "--codemode":
				out.codemode = parseOneOf(flag, next(), CODEMODE_STATES);
				break;
			case "--out":
			case "-o":
				out.out = next();
				break;
			case "--compare-to":
				out.compareTo = next();
				break;
			case "--cwd":
				out.cwd = next();
				break;
			case "--agent-dir":
				out.agentDir = next();
				break;
			case "--provider":
				out.provider = next();
				break;
			case "--model":
				out.model = next();
				break;
			case "--thinking":
				out.thinking = next();
				break;
			case "--model-refresh":
				out.modelRefresh = parseOneOf(flag, next(), REFRESH_MODES);
				break;
			case "--cold-nonce":
				out.coldNonce = bool();
				break;
			case "--mode-command":
				out.modeCommand = next();
				break;
			case "--codemode-command":
				out.codemodeCommand = next();
				break;
			case "--settle-timeout":
				out.settleTimeoutMs = parseIntFlag(flag, next());
				break;
			case "--child-timeout":
				out.childTimeoutMs = parseIntFlag(flag, next());
				break;
			case "--dry-run":
				out.dryRun = bool();
				break;
			case "--self-test":
				out.selfTest = bool();
				break;
			case "--verbose":
				out.verbose = bool();
				break;
			case "--allow-missing-mode-command":
				out.allowMissingModeCommand = bool();
				break;
			case "--startup-prompt":
				out.startupPrompt = next();
				break;
			case "--delegate-prompt":
				out.delegatePrompt = next();
				break;
			default:
				throw new UsageError(`unknown option: ${flag}`);
		}
	}
	return out;
}

export function resolveOptions(argv: string[]): BenchOptions | undefined {
	const parsed = parseArgs(argv);
	if (parsed.help) return undefined;
	const opts: BenchOptions = {
		workflow: (parsed.workflow ?? DEFAULTS.workflow) as Workflow,
		samples: parsed.samples ?? DEFAULTS.samples,
		target: parsed.target,
		mode: (parsed.mode ?? DEFAULTS.mode) as BenchMode,
		codemode: (parsed.codemode ?? DEFAULTS.codemode) as CodemodeState,
		out: parsed.out,
		compareTo: parsed.compareTo,
		cwd: parsed.cwd ?? `${homedir()}/Code`,
		agentDir: parsed.agentDir,
		provider: parsed.provider ?? DEFAULTS.provider,
		model: parsed.model ?? DEFAULTS.model,
		thinking: parsed.thinking ?? DEFAULTS.thinking,
		modelRefresh: (parsed.modelRefresh ?? DEFAULTS.modelRefresh) as ModelRefresh,
		coldNonce: parsed.coldNonce ?? DEFAULTS.coldNonce,
		modeCommand: parsed.modeCommand ?? DEFAULTS.modeCommand,
		codemodeCommand: parsed.codemodeCommand ?? DEFAULTS.codemodeCommand,
		settleTimeoutMs: parsed.settleTimeoutMs ?? DEFAULTS.settleTimeoutMs,
		childTimeoutMs: parsed.childTimeoutMs ?? DEFAULTS.childTimeoutMs,
		dryRun: parsed.dryRun ?? false,
		selfTest: parsed.selfTest ?? false,
		help: false,
		verbose: parsed.verbose ?? false,
		allowMissingModeCommand: parsed.allowMissingModeCommand ?? false,
		startupPrompt: parsed.startupPrompt ?? DEFAULTS.startupPrompt,
		delegatePrompt: parsed.delegatePrompt ?? DEFAULTS.delegatePrompt,
	};
	if (parsed.delegatePrompt === undefined) opts.delegatePrompt = delegationPrompt(controlledArguments(opts));
	if (!opts.selfTest && !opts.dryRun) {
		require(opts.target !== undefined, "--target <absolute extension entry path> is required for live runs");
	}
	if (opts.target !== undefined) {
		require(opts.target.startsWith("/"), `--target must be an absolute path (got "${opts.target}")`);
	}
	if (parsed._.length > 0) throw new UsageError(`unexpected positional arguments: ${parsed._.join(" ")}`);
	return opts;
}

export function helpText(command: string): string {
	return `pi-core-subagent before/after benchmark harness

Usage:
  bun ${command} [options]

Workflows:
  startup    fresh parent session, prompt "hi", capture tokens/tools/timings
  delegate   one real read-only BENCH_OK child delegation through the extension
  all        both workflows, in that order (default)

Options:
  -w, --workflow <startup|delegate|all>   default: all
  -n, --samples <count>                   samples per workflow, default: 3
  -t, --target <abs path>                 extension entry path under test, e.g.
                                          /tmp/pi-subagents-modes.luyKyX/baseline/src/index.ts
                                          or packages/core/pi-core-subagent/src/index.ts
                                          (required for live runs; optional for --dry-run)
      --mode <baseline|direct|codemode|auto>
                                          default: baseline. baseline never invokes the
                                          /subagents mode command (frozen baseline has none);
                                          direct|codemode|auto invoke --mode-command first.
      --codemode <active|on|only|disabled>
                                          default: active. active enables codemode with the
                                          settings mode; on|only force codemode.mode and
                                          enable it; disabled removes the codemode tool
                                          and factory from the parent session.
      --mode-command <template>           default: "/subagents mode {mode}" ({mode} replaced)
      --codemode-command <template>       default: "" (not invoked); {state} replaced
  -o, --out <file>                        report JSON path (default bench/results/<stamp>.json)
      --compare-to <baseline.json>        merge a previously written report into the
                                          baseline-vs-candidate comparison table
      --cwd <dir>                         session cwd, default: ~/Code
      --agent-dir <dir>                   pi agent dir, default: resolved by the SDK (~/.pi/agent)
      --provider <id>                     default: opencode-go
      --model <id>                        default: deepseek-v4.1-flash
      --thinking <level>                  default: max
      --model-refresh <offline|network>   model catalog refresh, default: offline
      --cold-nonce                        prepend a same-length per-sample nonce to prompts
                                          (explicit prefix change; cache counts stay authoritative)
      --settle-timeout <ms>               wait for agent_settled, default: 180000
      --child-timeout <ms>                wait for child completion, default: 180000
      --allow-missing-mode-command        continue when mode != baseline and the loaded
                                          extension has no /subagents command
      --startup-prompt <text>             default: "hi"
      --delegate-prompt <text>            natural-language delegation instruction
      --dry-run                           build settings/loader/session offline, no model calls
      --self-test                         run synthetic report/collector self-test, no API calls
      --verbose                           print per-sample progress and events
  -h, --help                              this text

Baseline (frozen extension, no /subagents command):
  bun ${command} --target /tmp/pi-subagents-modes.luyKyX/baseline/src/index.ts \\
      --mode baseline --workflow all --samples 3 --out bench/results/baseline.json

Future source (invokes /subagents mode <mode> first, plus optional codemode command):
  bun ${command} --target packages/core/pi-core-subagent/src/index.ts \\
      --mode codemode --codemode on --workflow all --samples 3 --out bench/results/codemode-on.json

Offline verification (no API calls):
  bun ${command} --help
  bun ${command} --self-test
  bun ${command} --dry-run --target /tmp/pi-subagents-modes.luyKyX/baseline/src/index.ts

Notes:
  * The harness loads the machine's normal settings/packages/skills/instructions, removes only
    npm:@arhen/pi-core-subagent from the package list in memory, and injects --target via
    additionalExtensionPaths, so the installed copy never double-registers.
  * The SDK does not auto-load codemode; the harness adds createCodemodeExtension itself.
  * Sessions are ephemeral (SessionManager.inMemory). Reported cache counts are used as-is:
    a fresh session is never claimed to be "cold" unless cacheRead is actually 0.
`;
}
