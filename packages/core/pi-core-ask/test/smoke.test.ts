/**
 * Smoke tests: validation guards + response envelope.
 * Pure logic only — no pi runtime needed. Run: bun test
 */
import { describe, expect, test } from "bun:test";
import { buildQuestionnaireResponse, validateQuestionnaire } from "../src/response.ts";
import type { QuestionParams } from "../src/types.ts";

function params(questions: QuestionParams["questions"]): QuestionParams {
	return { questions };
}

const okQuestions = [
	{
		question: "Which library?",
		header: "Library",
		options: [
			{ label: "A (Recommended)", description: "Option A" },
			{ label: "B", description: "Option B" },
		],
	},
];

describe("validateQuestionnaire", () => {
	test("valid questionnaire passes", () => {
		expect(validateQuestionnaire(params(okQuestions)).ok).toBe(true);
	});
	test("no questions rejected", () => {
		expect(validateQuestionnaire(params([])).ok).toBe(false);
	});
	test(">4 questions rejected", () => {
		const q = Array.from({ length: 5 }, (_, i) => ({ ...okQuestions[0]!, question: `q${i}` }));
		expect(validateQuestionnaire(params(q)).ok).toBe(false);
	});
	test("duplicate question rejected", () => {
		expect(validateQuestionnaire(params([okQuestions[0]!, okQuestions[0]!])).ok).toBe(false);
	});
	test("reserved label rejected (Other)", () => {
		const q = [{ ...okQuestions[0]!, options: [{ label: "Other", description: "x" }, { label: "B", description: "y" }] }];
		expect(validateQuestionnaire(params(q)).ok).toBe(false);
	});
	test("reserved label rejected (Type something.)", () => {
		const q = [{ ...okQuestions[0]!, options: [{ label: "Type something.", description: "x" }, { label: "B", description: "y" }] }];
		expect(validateQuestionnaire(params(q)).ok).toBe(false);
	});
	test("duplicate option label rejected", () => {
		const q = [{ ...okQuestions[0]!, options: [{ label: "Same", description: "x" }, { label: "Same", description: "y" }] }];
		expect(validateQuestionnaire(params(q)).ok).toBe(false);
	});
	test("1 option rejected", () => {
		const q = [{ ...okQuestions[0]!, options: [{ label: "Only", description: "x" }] }];
		expect(validateQuestionnaire(params(q)).ok).toBe(false);
	});
});

describe("envelope", () => {
	test("cancelled → decline message", () => {
		const r = buildQuestionnaireResponse({ answers: [], cancelled: true }, params(okQuestions));
		expect(r.content[0]?.text).toContain("declined");
	});
	test("option answer formatted as Q=A", () => {
		const r = buildQuestionnaireResponse(
			{
				answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "A (Recommended)" }],
				cancelled: false,
			},
			params(okQuestions),
		);
		expect(r.content[0]?.text).toContain('"Which library?"="A (Recommended)"');
		expect(r.content[0]?.text).toContain("continue with the user's answers");
	});
	test("multi answer joins selected", () => {
		const r = buildQuestionnaireResponse(
			{
				answers: [{ questionIndex: 0, question: "Which?", kind: "multi", answer: null, selected: ["A", "B"] }],
				cancelled: false,
			},
			params(okQuestions),
		);
		expect(r.content[0]?.text).toContain('"Which?"="A, B"');
	});
	test("custom answer included", () => {
		const r = buildQuestionnaireResponse(
			{
				answers: [{ questionIndex: 0, question: "Which?", kind: "custom", answer: "my own" }],
				cancelled: false,
			},
			params(okQuestions),
		);
		expect(r.content[0]?.text).toContain('"Which?"="my own"');
	});
	test("preview echoed", () => {
		const r = buildQuestionnaireResponse(
			{
				answers: [{ questionIndex: 0, question: "Which?", kind: "option", answer: "A", preview: "```\ncode\n```" }],
				cancelled: false,
			},
			params(okQuestions),
		);
		expect(r.content[0]?.text).toContain("selected preview:");
	});
});
