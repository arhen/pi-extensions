/**
 * Boxed questionnaire component — one question at a time, option list with
 * preview pane, "Type something." free-text row, multi-select toggles,
 * progress dots. Built on pi-tui primitives (SelectList + Input); Esc
 * anywhere cancels. Mirrors the visual language of pi's own dialogs.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, Key, matchesKey, SelectList, type SelectItem, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { QuestionAnswer, QuestionData } from "./types.ts";

const TYPE_ROW_VALUE = "__type_something__";
const isTypeRow = (v: string): boolean => v === TYPE_ROW_VALUE || v.startsWith("__type_something__");

export class QuestionnaireComponent implements Component {
	private tab = 0;
	private answers: Array<QuestionAnswer | null>;
	private customMode = false;
	private input = new Input();
	private multiChecked = new Set<number>();
	private done: (result: { answers: QuestionAnswer[]; cancelled: boolean }) => void;
	private select: SelectList;
	private finished = false;

	constructor(
		private readonly questions: QuestionData[],
		private readonly tui: TUI,
		private readonly theme: Theme,
		done: (result: { answers: QuestionAnswer[]; cancelled: boolean }) => void,
	) {
		this.answers = questions.map(() => null);
		this.done = done;
		this.select = this.buildSelect();
	}

	// ── state helpers ────────────────────────────────────────────────────

	private itemsFor(q: QuestionData): SelectItem[] {
		const items: SelectItem[] = q.options.map((o) => ({
			value: o.label,
			label: o.label,
			description: o.description,
		}));
		items.push({ value: TYPE_ROW_VALUE, label: "Type something.", description: "Type a custom answer" });
		return items;
	}

	private buildSelect(): SelectList {
		const t = this.theme;
		const q = this.currentQuestion();
		const select = new SelectList(this.itemsFor(q), Math.min(8, q.options.length + 2), {
			selectedPrefix: (text) => t.fg("accent", text),
			selectedText: (text) => t.fg("accent", text),
			description: (text) => t.fg("muted", text),
			scrollInfo: (text) => t.fg("dim", text),
			noMatch: (text) => t.fg("warning", text),
		});
		select.onSelectionChange = () => this.tui.requestRender();
		select.onCancel = () => this.finish(true);
		select.onSelect = (item) => {
			if (item) this.onRow(item); // Enter on an empty list yields null — ignore
		};
		return select;
	}

	private currentQuestion(): QuestionData {
		return this.questions[this.tab]!;
	}

	private currentAnswer(): QuestionAnswer | null {
		return this.answers[this.tab] ?? null;
	}

	// ── actions ──────────────────────────────────────────────────────────

	private onRow(item: SelectItem): void {
		const q = this.currentQuestion();
		if (isTypeRow(item.value)) {
			this.customMode = true;
			this.input.setValue("");
			this.tui.requestRender();
			return;
		}
		if (q.multiSelect) {
			const idx = q.options.findIndex((o) => o.label === item.value);
			if (this.multiChecked.has(idx)) {
				this.multiChecked.delete(idx);
				// Drop the unchecked label from the saved selection so saveMulti()
				// can't re-promote it into multiChecked (uncheck used to be a no-op).
				const prev = this.currentAnswer();
				if (prev?.kind === "multi") {
					prev.selected = (prev.selected ?? []).filter((label) => label !== item.value);
				}
			} else this.multiChecked.add(idx);
			this.saveMulti();
			this.tui.requestRender();
			return;
		}
		const opt = q.options.find((o) => o.label === item.value)!;
		this.answers[this.tab] = {
			questionIndex: this.tab,
			question: q.question,
			kind: "option",
			answer: opt.label,
			...(opt.preview ? { preview: opt.preview } : {}),
		};
		this.advance();
	}

	private commitCustom(value: string): void {
		const q = this.currentQuestion();
		if (q.multiSelect) {
			const prev = this.currentAnswer();
			const selected = [...(prev?.kind === "multi" ? prev.selected ?? [] : [])];
			const trimmed = value.trim();
			if (trimmed && !selected.includes(trimmed)) selected.push(trimmed);
			this.answers[this.tab] = { questionIndex: this.tab, question: q.question, kind: "multi", answer: null, selected };
			this.customMode = false;
			this.tui.requestRender();
			return;
		}
		const trimmed = value.trim();
		if (!trimmed) {
			this.customMode = false; // blank submit → back to options
			this.tui.requestRender();
			return;
		}
		this.answers[this.tab] = { questionIndex: this.tab, question: q.question, kind: "custom", answer: trimmed };
		this.advance();
	}

	private saveMulti(): void {
		const q = this.currentQuestion();
		if (!q.multiSelect) return; // single-select/custom answers are owned by onRow/commitCustom
		const selected: string[] = [];
		for (const idx of this.multiChecked) selected.push(q.options[idx]!.label);
		// Keep typed custom entries from a previous commit; a custom that happens to
		// equal an option label is promoted to a toggle so it can never be lost.
		const prev = this.currentAnswer();
		if (prev?.kind === "multi") {
			for (const label of prev.selected ?? []) {
				const idx = q.options.findIndex((o) => o.label === label);
				if (idx >= 0) this.multiChecked.add(idx);
				else if (!selected.includes(label)) selected.push(label);
			}
		}
		selected.sort((a, b) => {
			const ia = q.options.findIndex((o) => o.label === a);
			const ib = q.options.findIndex((o) => o.label === b);
			return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
		});
		this.answers[this.tab] = selected.length > 0 ? { questionIndex: this.tab, question: q.question, kind: "multi", answer: null, selected } : null;
	}

	/** Move to another question, restoring its saved state (answers, selection, custom text). */
	private goTo(tab: number): void {
		if (tab < 0 || tab >= this.questions.length || tab === this.tab) return;
		this.saveMulti();
		this.tab = tab;
		this.multiChecked = this.restoreChecked();
		const saved = this.currentAnswer();
		this.customMode = saved?.kind === "custom";
		if (this.customMode) this.input.setValue(saved?.answer ?? "");
		this.select = this.buildSelect();
		// Preselect the previously chosen option, if any.
		if (saved?.kind === "option") {
			const idx = this.questions[tab]!.options.findIndex((o) => o.label === saved.answer);
			if (idx >= 0) this.select.setSelectedIndex(idx);
		}
		this.tui.requestRender();
	}

	private advance(): void {
		if (this.tab < this.questions.length - 1) {
			this.goTo(this.tab + 1);
			return;
		}
		this.finish(false);
	}

	private restoreChecked(): Set<number> {
		const q = this.currentQuestion();
		const a = this.currentAnswer();
		const set = new Set<number>();
		if (q.multiSelect && a?.kind === "multi") {
			for (let i = 0; i < q.options.length; i++) {
				if (a.selected!.includes(q.options[i]!.label)) set.add(i);
			}
		}
		return set;
	}

	private finish(cancelled: boolean): void {
		if (this.finished) return; // first outcome wins — stale events can't flip the result
		this.finished = true;
		if (cancelled) {
			this.done({ answers: [], cancelled: true });
			return;
		}
		this.saveMulti();
		this.done({ answers: this.answers.filter((a): a is QuestionAnswer => a !== null), cancelled: false });
	}

	// ── Component ────────────────────────────────────────────────────────

	invalidate(): void {
		/* no cached strings */
	}

	handleInput(data: string): void {
		if (this.finished) return; // stale keys after done can't mutate answers
		if (this.customMode) {
			// Explicit keys: Enter submits the typed answer, Esc returns to options.
			// Intercepting here (not via Input callbacks) keeps the flow deterministic.
			if (matchesKey(data, Key.enter)) {
				this.commitCustom(this.input.getValue());
				return;
			}
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
				this.customMode = false;
				this.tui.requestRender();
				return;
			}
			this.input.handleInput(data);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.finish(true);
			return;
		}
		// ← / → navigate between questions (answers are preserved per question).
		if (matchesKey(data, Key.left)) {
			this.goTo(this.tab - 1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.goTo(this.tab + 1);
			return;
		}
		// Ctrl+S: commit multiSelect questions only (single-select commits on Enter).
		if (matchesKey(data, Key.ctrl("s")) && this.currentQuestion().multiSelect) {
			this.saveMulti();
			this.advance();
			return;
		}
		this.select.handleInput(data);
	}

	render(width: number): string[] {
		const q = this.currentQuestion();
		const lines: string[] = [];
		const boxWidth = Math.min(width - 4, 100);
		const contentWidth = boxWidth - 4;
		const pad = (line: string): string => line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const dim = (s: string): string => this.theme.fg("dim", s);
		const bar = (): string => dim("├" + "─".repeat(boxWidth - 2) + "┤");
		const row = (content: string): string => dim("│") + " " + content + " ".repeat(Math.max(0, boxWidth - visibleWidth(content) - 3)) + dim("│");

		lines.push(pad(dim("╭" + "─".repeat(boxWidth - 2) + "╮")));
		lines.push(pad(row(`${this.theme.fg("accent", this.theme.bold("Questions"))} ${this.theme.fg("dim", `(${this.tab + 1}/${this.questions.length})`)}`)));
		lines.push(pad(bar()));

		// progress dots
		const dots = this.questions
			.map((_, i) => {
				if (i === this.tab) return this.theme.fg("accent", "●");
				if (this.answers[i]) return this.theme.fg("success", "●");
				return dim("○");
			})
			.join(" ");
		lines.push(pad(row(dots)));
		lines.push(pad(row("")));

		// header chip + question
		lines.push(pad(row(this.theme.fg("accent", `[${q.header}]`))));
		for (const line of wrapTextWithAnsi(this.theme.bold(q.question), contentWidth - 2)) {
			lines.push(pad(row(line)));
		}
		lines.push(pad(row("")));

		if (this.customMode) {
			const inputLines = this.input.render(contentWidth - 6);
			for (const line of inputLines) lines.push(pad(row(line)));
			lines.push(pad(row(this.theme.fg("dim", "Enter to submit custom answer · Esc back to options"))));
		} else {
			const selected = this.select.getSelectedItem();
			for (const line of this.select.render(boxWidth - 4)) {
				lines.push(pad(row(line)));
			}
			// multi-select check state
			if (q.multiSelect) {
				const checked = [...this.multiChecked].map((i) => q.options[i]!.label);
				const custom = this.currentAnswer()?.kind === "multi" ? (this.currentAnswer()!.selected ?? []).filter((l) => !q.options.some((o) => o.label === l)) : [];
				const shown = [...checked, ...custom].join(", ");
				if (shown) lines.push(pad(row(this.theme.fg("success", `✓ ${shown}`))));
			}
			lines.push(pad(row("")));
			// Pane for the focused option: full wrapped description + preview if present.
			const focused = selected && !isTypeRow(selected.value) ? q.options.find((o) => o.label === selected.value) : undefined;
			if (focused) {
				lines.push(pad(bar()));
				lines.push(pad(row(this.theme.fg("accent", "Description"))));
				const descLines = wrapTextWithAnsi(focused.description, contentWidth - 2);
				for (const line of descLines.slice(0, 8)) {
					lines.push(pad(row(this.theme.fg("dim", line))));
				}
				if (descLines.length > 8) lines.push(pad(row(this.theme.fg("dim", `… +${descLines.length - 8} more lines`))));
				if (focused.preview) {
					lines.push(pad(row("")));
					lines.push(pad(row(this.theme.fg("accent", "Preview"))));
					const previewLines = focused.preview.split("\n");
					for (const line of previewLines.slice(0, 8)) {
						lines.push(pad(row(this.theme.fg("dim", truncateToWidth(line, contentWidth - 2)))));
					}
					if (previewLines.length > 8) lines.push(pad(row(this.theme.fg("dim", `… +${previewLines.length - 8} more lines`))));
				}
				lines.push(pad(bar()));
			}
		}

		lines.push(pad(bar()));
		const multi = q.multiSelect ? "Enter toggle · Ctrl+S done · " : "Enter next · ";
		const controls = dim(`${multi}←/→ prev/next · ↑↓ select · Type something. = custom · Esc cancel`);
		lines.push(pad(row(truncateToWidth(controls, contentWidth))));
		lines.push(pad(dim("╰" + "─".repeat(boxWidth - 2) + "╯")));
		return lines;
	}
}
