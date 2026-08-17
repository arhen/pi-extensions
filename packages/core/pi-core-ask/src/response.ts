/**
 * Pure validation + response envelope. Verbatim semantics from
 * rpiv-ask-user-question (messages pinned by its tests).
 */

import type { QuestionAnswer, QuestionnaireError, QuestionParams, QuestionnaireResult } from "./types.ts";
import { MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, RESERVED_LABELS } from "./types.ts";

export const ERROR_NO_QUESTIONS = "Error: At least one question is required";
export const ERROR_TOO_MANY_QUESTIONS = `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`;
export const ERROR_DUPLICATE_QUESTION = "Error: Question text must be unique within an invocation";
export const ERROR_TOO_FEW_OPTIONS = `Error: Each question requires at least ${MIN_OPTIONS} options`;
export const ERROR_RESERVED_LABEL = `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})`;
export const ERROR_DUPLICATE_OPTION_LABEL = "Error: Option labels must be unique within a question";
export const ERROR_EMPTY_LABEL = "Error: Option label must not be empty";

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

export type ValidationResult = { ok: true } | { ok: false; error: QuestionnaireError; message: string };

export function validateQuestionnaire(typed: QuestionParams): ValidationResult {
	if (typed.questions.length === 0) return { ok: false, error: "no_questions", message: ERROR_NO_QUESTIONS };
	if (typed.questions.length > MAX_QUESTIONS) return { ok: false, error: "too_many_questions", message: ERROR_TOO_MANY_QUESTIONS };

	const seenQuestions = new Set<string>();
	for (const q of typed.questions) {
		const question = q.question.trim();
		if (seenQuestions.has(question)) return { ok: false, error: "duplicate_question", message: ERROR_DUPLICATE_QUESTION };
		seenQuestions.add(question);
	}

	for (const q of typed.questions) {
		if (q.options.length < MIN_OPTIONS) return { ok: false, error: "empty_options", message: ERROR_TOO_FEW_OPTIONS };
		const seenLabels = new Set<string>();
		for (const o of q.options) {
			const label = o.label.trim(); // L6: compare trimmed
			if (label.length === 0) return { ok: false, error: "invalid_label", message: ERROR_EMPTY_LABEL };
			if (RESERVED_LABEL_SET.has(label) || label.startsWith("__type_something__")) {
				return { ok: false, error: "reserved_label", message: ERROR_RESERVED_LABEL };
			}
			if (seenLabels.has(label)) return { ok: false, error: "duplicate_option_label", message: ERROR_DUPLICATE_OPTION_LABEL };
			seenLabels.add(label);
			if (q.multiSelect && o.preview !== undefined && o.preview.trim().length > 0) {
				return { ok: false, error: "preview_on_multiselect", message: "Error: preview is only supported on single-select questions" };
			}
		}
	}

	return { ok: true };
}

// ── envelope ─────────────────────────────────────────────────────────────

export const DECLINE_MESSAGE = "User declined to answer questions";
export const ENVELOPE_PREFIX = "User has answered your questions:";
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
export const NO_INPUT_PLACEHOLDER = "(no input)";

export function formatAnswerScalar(a: QuestionAnswer): string {
	switch (a.kind) {
		case "multi":
			return a.selected && a.selected.length > 0 ? a.selected.join(", ") : NO_INPUT_PLACEHOLDER;
		case "custom":
			return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
		case "option":
			return a.answer ?? NO_INPUT_PLACEHOLDER;
	}
}

export function buildAnswerSegment(a: QuestionAnswer): string {
	const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a)}"`];
	if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
	if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
	return `${parts.join(". ")}.`;
}

export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
	if (!result || result.cancelled) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result?.answers ?? [], cancelled: true });
	}
	const segments: string[] = [];
	for (let i = 0; i < params.questions.length; i++) {
		const a = result.answers.find((x) => x.questionIndex === i);
		if (a) segments.push(buildAnswerSegment(a));
	}
	if (segments.length === 0) {
		return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
	}
	return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}
