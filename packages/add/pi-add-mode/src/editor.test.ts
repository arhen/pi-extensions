import { describe, expect, test } from "bun:test";
import { ModeEditor } from "./editor.ts";

const MARK = (text: string) => `<M>${text}</M>`;

function makeEditor(): ModeEditor {
	const tui = { terminal: { rows: 24 }, requestRender() {} };
	const theme = { borderColor: (text: string) => text, selectList: {} };
	const editor = new ModeEditor(tui as any, theme as any, {} as any);
	editor.borderColor = (text: string) => `<PI>${text}</PI>`;
	return editor;
}

describe("ModeEditor border tint", () => {
	test("render restores pi's borderColor", () => {
		const editor = makeEditor();
		const piColor = editor.borderColor;
		editor.setModeBorder(MARK);
		editor.render(40);
		expect(editor.borderColor).toBe(piColor);
	});

	test("tint covers top and bottom border lines and clears again", () => {
		const editor = makeEditor();
		editor.setModeBorder(MARK);
		const tinted = editor.render(40);
		expect(tinted[0]).toContain("<M>");
		expect(tinted[tinted.length - 1]).toContain("<M>");

		editor.setModeBorder(undefined);
		const plain = editor.render(40);
		expect(plain[0]).not.toContain("<M>");
		expect(plain[plain.length - 1]).not.toContain("<M>");
	});

	test("bash mode keeps pi's border cue and hides the mode label", () => {
		const editor = makeEditor();
		editor.setModeBorder(MARK);
		editor.setModeStandby("review standby");
		editor.setText("!ls");
		const lines = editor.render(40);
		expect(lines[0]).not.toContain("<M>");
		expect(lines[0]).not.toContain("review standby");
	});

	test("pi reassignment between renders wins once the tint is cleared", () => {
		const editor = makeEditor();
		editor.setModeBorder(MARK);
		editor.render(40);
		editor.borderColor = (text: string) => `<OTHER>${text}</OTHER>`;
		editor.setModeBorder(undefined);
		expect(editor.render(40)[0]).toContain("<OTHER>");
	});
});
