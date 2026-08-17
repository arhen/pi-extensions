/**
 * @arhen/pi-ask — minimalist questionnaire. Registers `ask_user_question`
 * with the same LLM-facing contract as rpiv-ask-user-question. Stateless:
 * no lifecycle events, no RPC fallback, no config — one tool, one dialog.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QuestionnaireComponent } from "./ui.ts";
import { buildQuestionnaireResponse, buildToolResult, validateQuestionnaire } from "./response.ts";
import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, QuestionParamsSchema, type QuestionParams, type QuestionnaireResult } from "./types.ts";

const TOOL_NAME = "ask_user_question";
const TOOL_LABEL = "Ask User Question";
const ERROR_NO_UI = "Error: questionnaire requires interactive mode";

const TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as plain text in a pane below the option list (multi-line supported). Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;
const DEFAULT_PROMPT_GUIDELINES: string[] = [
	`Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
	`Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
	`Set multiSelect: true when multiple answers are valid. Provide an options[].preview string when an option benefits from richer context (mockups, code snippets, diagrams, configs) — single-select only. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
	"Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof QuestionParamsSchema, QuestionnaireResult>({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description: TOOL_DESCRIPTION,
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const typed: QuestionParams = params;
			if (ctx.mode !== "tui") {
				return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
			}
			const validation = validateQuestionnaire(typed);
			if (!validation.ok) {
				return buildToolResult(validation.message, { answers: [], cancelled: true, error: validation.error });
			}

			const result = await ctx.ui.custom<QuestionnaireResult>(
				(tui, theme, _keybindings, done) =>
					new QuestionnaireComponent(typed.questions, tui, theme, (r) =>
						done({ answers: r.answers, cancelled: r.cancelled }),
					),
			);

			return buildQuestionnaireResponse(result ?? null, typed);
		},
	});
}
