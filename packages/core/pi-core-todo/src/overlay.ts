import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { getRenderState } from "./store.ts";
import type { TaskState } from "./types.ts";
import { WIDGET_KEY } from "./types.ts";
import { renderWidget } from "./view.ts";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;

	get terminalRows(): number {
		return this.tui?.terminal.rows ?? process.stdout.rows ?? 32;
	}

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const state = getRenderState();
		this.trackSnapshot(state);
		if (!state.tasks.some((task) => task.status !== "deleted" && !this.hiddenCompletedTaskIds.has(task.id))) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, factoryTheme) => {
					this.tui = tui;
					return {
						render: (width) => {
							const state = getRenderState();
							this.trackSnapshot(state);
							const result = renderWidget(
								state,
								this.hiddenCompletedTaskIds,
								this.uiCtx?.theme ?? factoryTheme,
								width,
								tui.terminal.rows,
							);
							for (const id of result.displayedIds) {
								if (state.tasks.find((task) => task.id === id)?.status === "completed")
									this.completedTaskIdsPendingHide.add(id);
							}
							return result.lines;
						},
						invalidate: () => {},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else this.tui?.requestRender();
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		for (const id of this.completedTaskIdsPendingHide) this.hiddenCompletedTaskIds.add(id);
		this.completedTaskIdsPendingHide.clear();
		this.update();
	}

	dispose(): void {
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.resetCompletedDisplayState();
	}

	private trackSnapshot(state: TaskState): void {
		if (this.lastNextId !== undefined && state.nextId < this.lastNextId) this.resetCompletedDisplayState();
		this.lastNextId = state.nextId;
		const completed = new Set(state.tasks.filter((task) => task.status === "completed").map((task) => task.id));
		for (const id of this.completedTaskIdsPendingHide) {
			if (!completed.has(id)) this.completedTaskIdsPendingHide.delete(id);
		}
		for (const id of this.hiddenCompletedTaskIds) {
			if (!completed.has(id)) this.hiddenCompletedTaskIds.delete(id);
		}
	}
}
