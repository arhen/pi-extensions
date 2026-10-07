import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUBAGENT_CONFIG_FILENAME } from "../../src/config.ts";

const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

export interface IsolatedAgentDir {
	dir: string;
	configFile: string;
	/** Read the stored config the running extension actually uses. */
	config(): Record<string, unknown>;
	/** Remove the config file, so the next test starts from the default preference. */
	reset(): void;
	restore(): void;
}

/**
 * Point `getAgentDir()` at a throwaway directory for one test file, so mode/auto-limit writes never
 * touch the real user config. Bun runs test files in one process, so the previous value is restored
 * when the file ends.
 */
export function isolateAgentDir(): IsolatedAgentDir {
	const original = process.env[ENV_AGENT_DIR];
	const dir = mkdtempSync(join(tmpdir(), "subagent-agentdir-"));
	process.env[ENV_AGENT_DIR] = dir;
	const configFile = join(dir, SUBAGENT_CONFIG_FILENAME);
	return {
		dir,
		configFile,
		config: () => {
			try {
				return JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
			} catch {
				return {};
			}
		},
		reset: () => rmSync(configFile, { force: true }),
		restore: () => {
			if (original === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = original;
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
