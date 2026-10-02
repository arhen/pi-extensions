import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Editor whose top border can show a standby label while the agent is idle.
 * Pi embeds its working indicator in the same border during streaming, so the
 * mode name appears in exactly the same place whether working or idle.
 */
export class ModeEditor extends CustomEditor {
	private standby?: string;
	private indicatorActive = false;

	setModeStandby(text: string | undefined): void {
		this.standby = text;
		this.invalidate();
	}

	override setWorkingStatusIndicator(indicator: any): void {
		this.indicatorActive = indicator !== undefined;
		super.setWorkingStatusIndicator(indicator);
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		const text = this.standby;
		if (this.indicatorActive || !text || width <= 0) return super.renderTopBorder(width, hiddenLineCount);
		const textWidth = visibleWidth(text);
		if (width < textWidth + 5) return super.renderTopBorder(width, hiddenLineCount);
		return this.borderColor("── ") + text + this.borderColor(` ${"─".repeat(width - textWidth - 4)}`);
	}
}
