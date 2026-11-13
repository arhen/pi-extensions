import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const TODO_CONFIG_FILENAME = "todo-config.json";

function todoConfigPath(): string {
	return join(getAgentDir(), TODO_CONFIG_FILENAME);
}

export function readTodoConfig(path = todoConfigPath()): { collapsed: boolean } {
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		return { collapsed: raw !== null && typeof raw === "object" && "collapsed" in raw && raw.collapsed === true };
	} catch {
		return { collapsed: false };
	}
}

let writeQueue = Promise.resolve();

export function writeTodoConfig(config: { collapsed: boolean }, path = todoConfigPath()): Promise<void> {
	const write = writeQueue.then(async () => {
		await mkdir(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		try {
			await writeFile(tmp, `${JSON.stringify({ collapsed: config.collapsed }, null, 2)}\n`);
			await rename(tmp, path);
		} finally {
			await rm(tmp, { force: true });
		}
	});
	writeQueue = write.catch(() => {});
	return write;
}

export function flushTodoConfigWrites(): Promise<void> {
	return writeQueue;
}
