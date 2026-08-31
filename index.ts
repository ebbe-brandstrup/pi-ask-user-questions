/**
 * ask-user-question — Interactive form tool for pi
 *
 * A powerful tool that the LLM can call to ask the user one or more questions
 * using rich form controls: radio buttons, checkboxes, and text inputs.
 * Each question type supports an optional "Other..." escape hatch for custom input.
 *
 * Question types:
 *   - radio:    Single-select from options (with optional custom "Other")
 *   - checkbox: Multi-select from options (with optional custom "Other")
 *   - text:     Free-form text input
 *
 * Navigation:
 *   - Tab / Shift+Tab to move between questions
 *   - Up/Down to navigate options within a question
 *   - Space to toggle checkboxes
 *   - Enter to select radio / submit text / advance
 *   - Esc to cancel
 *   - Ctrl+C twice to cancel (pi delivers Ctrl+C to the focused component,
 *     so an unhandled press would be silently swallowed)
 *
 * Rendering: the form replaces the editor in the document flow (ctx.ui.custom's
 * default mode) and is internally clamped to the terminal height. The clamp
 * keeps the form within the viewport so pi's animated working spinner (rendered
 * above the form) never falls above the TUI's viewport top — which would force
 * a full-screen repaint on every spinner tick (~80ms flicker).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface Question {
	id: string;
	type: "radio" | "checkbox" | "text";
	prompt: string;
	label?: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: string | string[];
}

interface NormalizedQuestion extends Question {
	label: string;
	options: QuestionOption[];
	allowOther: boolean;
	required: boolean;
}

interface Answer {
	id: string;
	type: "radio" | "checkbox" | "text";
	value: string | string[];
	wasCustom: boolean;
}

interface FormResult {
	title?: string;
	questions: NormalizedQuestion[];
	answers: Answer[];
	cancelled: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected" }),
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Help text shown below the label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	type: StringEnum(["radio", "checkbox", "text"] as const, {
		description: "Question type: radio (single-select), checkbox (multi-select), or text (free input)",
	}),
	prompt: Type.String({ description: "The question text to display" }),
	label: Type.Optional(Type.String({ description: "Short label for tab bar (defaults to Q1, Q2...)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for radio/checkbox types" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Add an 'Other...' option with text input (default: true for radio/checkbox)" }),
	),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required (default: true)" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for text inputs" })),
	default: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Default value(s). String for radio/text, string[] for checkbox",
		}),
	),
});

const AskUserQuestionParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Form title displayed at the top" })),
	description: Type.Optional(Type.String({ description: "Brief context or instructions shown under the title" })),
	questions: Type.Array(QuestionSchema, {
		description: "One or more questions to ask. Use radio for single-select, checkbox for multi-select, text for free input",
	}),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalize(questions: Question[]): NormalizedQuestion[] {
	return questions.map((q, i) => ({
		...q,
		label: q.label || `Q${i + 1}`,
		options: q.options || [],
		allowOther: q.type === "text" ? false : q.allowOther !== false,
		required: q.required !== false,
	}));
}

function errorResult(msg: string): {
	content: { type: "text"; text: string }[];
	details: FormResult;
} {
	return {
		content: [{ type: "text", text: msg }],
		details: { questions: [], answers: [], cancelled: true },
	};
}

// ─── Symbols ─────────────────────────────────────────────────────────────────

const SYM = {
	radioOn: "◉",
	radioOff: "○",
	checkOn: "☑",
	checkOff: "☐",
	pointer: "❯",
	dot: "·",
	check: "✓",
	pencil: "✎",
	submit: "✓",
};

function shortenLabel(label: string, maxWidth: number): string {
	return truncateToWidth(label, Math.max(1, maxWidth));
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description: `Ask the user one or more questions using an interactive form. Supports three question types:
- **radio**: Single-select from predefined options (like multiple choice)
- **checkbox**: Multi-select from options (pick all that apply)
- **text**: Free-form text input

Each radio/checkbox question can include an "Other..." option that lets the user type a custom answer.

Use this tool when you need user input to proceed — for clarifying requirements, getting preferences, confirming decisions, or choosing between alternatives. Prefer this over asking plain-text questions in your response.`,
		promptSnippet: "Ask the user interactive questions with radio, checkbox, or text inputs",
		promptGuidelines: [
			"Use ask_user_question instead of asking questions in plain text when you need structured user input.",
			"Prefer radio for single-choice, checkbox for multi-choice, text for open-ended answers.",
			"Always include an 'Other' escape hatch (allowOther: true) unless the options are exhaustive.",
			"Group related questions in a single call rather than making multiple separate calls.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (!params.questions.length) {
				return errorResult("Error: No questions provided");
			}

			const questions = normalize(params.questions as Question[]);
			const isMulti = questions.length > 1;
			const totalTabs = questions.length + (isMulti ? 1 : 0); // +1 for Submit tab

			// Tell integrations (e.g. herdr) that the agent is blocked on user input.
			// herdr's pi integration listens for "herdr:blocked" { active, label }.
			pi.events.emit("herdr:blocked", {
				active: true,
				label: (params.title as string | undefined)?.trim() || "ask_user_question",
			});

			let result: FormResult | undefined;
			try {
				result = await ctx.ui.custom<FormResult>((tui, theme, _kb, done) => {
					// ── State ────────────────────────────────────────────────
					let currentTab = 0;
					let cursorIdx = 0; // cursor within current question's options
					let otherMode = false; // typing into "Other..." editor
					let otherQuestionId: string | null = null;
					let cachedLines: string[] | undefined;
					let cachedWidth = -1;
					let cachedRows = -1;
					let scrollWinStart = 0; // scroll window start for question-tab option rows
					let submitScroll = 0; // scroll window start for the submit-tab review list
					let lastCtrlCAt = 0;

					// Answers store
					const radioAnswers = new Map<string, { value: string; label: string; wasCustom: boolean }>();
					const checkAnswers = new Map<string, Set<string>>(); // id -> set of selected values
					const checkCustom = new Map<string, string>(); // id -> custom "other" text
					const textAnswers = new Map<string, string>();

					// Initialize defaults
					for (const q of questions) {
						if (q.type === "checkbox") {
							const defaults = new Set<string>();
							if (Array.isArray(q.default)) {
								for (const v of q.default) defaults.add(v);
							}
							checkAnswers.set(q.id, defaults);
						} else if (q.type === "text" && typeof q.default === "string") {
							textAnswers.set(q.id, q.default);
						} else if (q.type === "radio" && typeof q.default === "string") {
							const opt = q.options.find((o) => o.value === q.default);
							if (opt) radioAnswers.set(q.id, { value: opt.value, label: opt.label, wasCustom: false });
						}
					}

					// Editor for "Other" and "text" fields
					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					function getNextTab(): number {
						if (currentTab < questions.length - 1) {
							return currentTab + 1;
						}
						return questions.length; // Submit tab
					}

					function advanceTab() {
						if (!(questions.length > 1)) {
							finishSubmit(false);
						} else {
							switchTab(getNextTab());
						}
					}

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function curQ(): NormalizedQuestion | undefined {
						return questions[currentTab];
					}

					/** Save "Other" editor text to the appropriate answer store and exit otherMode. */
					function saveOtherModeText() {
						if (!otherMode || !otherQuestionId) return;
						const t = editor.getText().trim();
						const oq = questions.find((q) => q.id === otherQuestionId);
						if (oq?.type === "radio" && t) {
							radioAnswers.set(oq.id, { value: t, label: t, wasCustom: true });
						} else if (oq?.type === "checkbox" && t) {
							checkCustom.set(oq.id, t);
						}
						otherMode = false;
						otherQuestionId = null;
						editor.setText("");
					}

					/** Total selectable rows for the current question */
					function optionCount(q: NormalizedQuestion): number {
						if (q.type === "text") return 0;
						return q.options.length + (q.allowOther ? 1 : 0);
					}

					function isAnswered(q: NormalizedQuestion): boolean {
						if (q.type === "radio") return radioAnswers.has(q.id);
						if (q.type === "checkbox") {
							const set = checkAnswers.get(q.id);
							const custom = checkCustom.get(q.id);
							return (set != null && set.size > 0) || (custom != null && custom.trim().length > 0);
						}
						if (q.type === "text") {
							return (textAnswers.get(q.id)?.trim() ?? "").length > 0;
						}
						return false;
					}

					function allRequired(): boolean {
						return questions.every((q) => !q.required || isAnswered(q));
					}

					function switchTab(idx: number) {
						// Save text editor state
						saveEditorText();
						currentTab = ((idx % totalTabs) + totalTabs) % totalTabs;
						cursorIdx = 0;
						otherMode = false;
						otherQuestionId = null;
						scrollWinStart = 0;
						submitScroll = 0;

						// If switching to a text question, load its value
						const q = curQ();
						if (q?.type === "text") {
							editor.setText(textAnswers.get(q.id) ?? "");
						}
						refresh();
					}

					function saveEditorText() {
						const q = curQ();
						if (!q) return;
						if (q.type === "text") {
							const t = editor.getText().trim();
							if (t) textAnswers.set(q.id, t);
							else textAnswers.delete(q.id);
						}
					}

					function finishSubmit(cancelled: boolean) {
						saveEditorText();
						const answers: Answer[] = [];
						for (const q of questions) {
							if (q.type === "radio") {
								const a = radioAnswers.get(q.id);
								answers.push({
									id: q.id,
									type: "radio",
									value: a?.value ?? "",
									wasCustom: a?.wasCustom ?? false,
								});
							} else if (q.type === "checkbox") {
								const set = checkAnswers.get(q.id) ?? new Set();
								const custom = checkCustom.get(q.id)?.trim();
								const values = [...set];
								if (custom) values.push(custom);
								answers.push({ id: q.id, type: "checkbox", value: values, wasCustom: !!custom });
							} else {
								const t = textAnswers.get(q.id) ?? "";
								answers.push({ id: q.id, type: "text", value: t, wasCustom: true });
							}
						}
						done({ title: params.title, questions, answers, cancelled });
					}

					// ── Editor submit (for "Other" mode) ────────────────────
					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (otherMode && otherQuestionId) {
							const q = questions.find((q) => q.id === otherQuestionId);
							if (q?.type === "radio" && trimmed) {
								radioAnswers.set(q.id, { value: trimmed, label: trimmed, wasCustom: true });
							} else if (q?.type === "checkbox" && trimmed) {
								checkCustom.set(q.id, trimmed);
							}
							otherMode = false;
							otherQuestionId = null;
							editor.setText("");

							// Auto-advance
							advanceTab();
							return;
						}

						// Text question submit (fallback — Enter is normally intercepted in handleInput
						// before reaching the editor, but handle it here defensively using `value`
						// since editor state is already cleared by the time onSubmit fires)
						const q = curQ();
						if (q?.type === "text") {
							const trimmedValue = value.trim();
							if (trimmedValue) {
								textAnswers.set(q.id, trimmedValue);
							} else {
								textAnswers.delete(q.id);
							}
							advanceTab();
						}
					};

					// ── Input handling ───────────────────────────────────────

					function handleInput(data: string) {
						// Ctrl+C is delivered to the focused component (pi routes all input
						// here, including Ctrl+C). Require a double-press within 1s to cancel
						// so a reflex press doesn't discard partial answers.
						if (matchesKey(data, Key.ctrl("c"))) {
							const now = Date.now();
							if (now - lastCtrlCAt <= 1000) {
								finishSubmit(true);
							} else {
								lastCtrlCAt = now;
							}
							return;
						}

						// "Other" editor mode
						if (otherMode) {
							if (matchesKey(data, Key.escape)) {
								otherMode = false;
								otherQuestionId = null;
								editor.setText("");
								refresh();
								return;
							}
							// Enter: capture text directly from editor (before it clears itself) and advance
							if (matchesKey(data, Key.enter)) {
								saveOtherModeText();
								advanceTab();
								return;
							}
							// Tab navigation in multi-question forms: save text and switch tab
							if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
								saveOtherModeText();
								switchTab(currentTab + (matchesKey(data, Key.shift("tab")) ? -1 : 1));
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						// Text question — route most input to editor
						const q = curQ();
						if (q?.type === "text") {
							// Enter: save text (editor still has content here) and advance
							if (matchesKey(data, Key.enter)) {
								saveEditorText();
								advanceTab();
								return;
							}
							// Tab navigation still works
							if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
								saveEditorText();
								switchTab(currentTab + (matchesKey(data, Key.shift("tab")) ? -1 : 1));
								return;
							}
							if (matchesKey(data, Key.escape)) {
								finishSubmit(true);
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}

						// Submit tab (multi-question only)
						if (isMulti && currentTab === questions.length) {
							if (matchesKey(data, Key.enter) && allRequired()) {
								finishSubmit(false);
								return;
							}
							// Scroll the review list (window is clamped in render())
							if (matchesKey(data, Key.up)) {
								submitScroll = Math.max(0, submitScroll - 1);
								refresh();
								return;
							}
							if (matchesKey(data, Key.down)) {
								submitScroll += 1;
								refresh();
								return;
							}
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
								switchTab(0);
								return;
							}
							if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
								switchTab(currentTab - 1);
								return;
							}
							if (matchesKey(data, Key.escape)) {
								finishSubmit(true);
								return;
							}
							return;
						}

						if (!q) return;

						// Tab navigation (multi)
						if (isMulti) {
							if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
								switchTab(currentTab + 1);
								return;
							}
							if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
								switchTab(currentTab - 1);
								return;
							}
						}

						// Arrow navigation
						const total = optionCount(q);
						if (matchesKey(data, Key.up)) {
							cursorIdx = Math.max(0, cursorIdx - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							cursorIdx = Math.min(total - 1, cursorIdx + 1);
							refresh();
							return;
						}

						// Escape
						if (matchesKey(data, Key.escape)) {
							finishSubmit(true);
							return;
						}

						// Radio select
						if (q.type === "radio" && matchesKey(data, Key.enter)) {
							const isOther = q.allowOther && cursorIdx === q.options.length;
							if (isOther) {
								otherMode = true;
								otherQuestionId = q.id;
								// Pre-fill with existing custom answer
								const existing = radioAnswers.get(q.id);
								editor.setText(existing?.wasCustom ? existing.label : "");
								refresh();
								return;
							}
							const opt = q.options[cursorIdx];
							if (opt) {
								radioAnswers.set(q.id, { value: opt.value, label: opt.label, wasCustom: false });
								advanceTab();
							}
							return;
						}

						// Checkbox toggle (space only)
						if (q.type === "checkbox" && matchesKey(data, Key.space)) {
							const isOther = q.allowOther && cursorIdx === q.options.length;
							if (isOther) {
								otherMode = true;
								otherQuestionId = q.id;
								editor.setText(checkCustom.get(q.id) ?? "");
								refresh();
								return;
							}
							const opt = q.options[cursorIdx];
							if (opt) {
								const set = checkAnswers.get(q.id) ?? new Set();
								if (set.has(opt.value)) set.delete(opt.value);
								else set.add(opt.value);
								checkAnswers.set(q.id, set);
								refresh();
							}
							return;
						}

						// Checkbox: Enter submits (single) or advances (multi)
						if (q.type === "checkbox" && matchesKey(data, Key.enter)) {
							advanceTab();
							return;
						}
					}

					// ── Render ───────────────────────────────────────────────

					function render(width: number): string[] {
						const rows = tui.terminal.rows || 24;
						if (cachedLines && cachedWidth === width && cachedRows === rows) return cachedLines;

						const maxW = width;
						// Height budget: pi renders a 2-line animated working spinner above this
						// component and a 1-line footer below it. If the form plus that chrome
						// exceeds the terminal height, the spinner's changing line falls above
						// the TUI's viewport top and every spinner tick (~80ms) forces a
						// full-screen clear + repaint — the "flicker". Cap the form height and
						// scroll the body instead of overflowing.
						const maxFormLines = Math.max(10, rows - 4);

						// Render into three bands: fixed head, scrollable body, fixed tail.
						const head: string[] = [];
						const body: string[] = [];
						const tail: string[] = [];
						// Cursor block within body ([start, end) line indices) for scroll-follow.
						let cursorStart = -1;
						let cursorEnd = -1;

						const into = (arr: string[]) => ({
							add: (s: string) => arr.push(truncateToWidth(s, maxW)),
							addWrapped: (s: string, wrapWidth = maxW, prefix = "") => {
								for (const line of wrapTextWithAnsi(s, Math.max(1, wrapWidth))) {
									arr.push(truncateToWidth(`${prefix}${line}`, maxW));
								}
							},
						});
						const hr = (arr: string[]) => arr.push(truncateToWidth(theme.fg("accent", "─".repeat(maxW)), maxW));

						const h = into(head);
						hr(head);

						// Title & description
						if (params.title) {
							h.addWrapped(` ${theme.fg("accent", theme.bold(params.title))}`);
						}
						if (params.description) {
							h.addWrapped(` ${theme.fg("muted", params.description)}`, maxW - 1, " ");
						}
						if (params.title || params.description) head.push("");

						// Tab bar (multi-question)
						if (isMulti) {
							const totalTabCount = questions.length + 1;
							const inactiveTabCount = totalTabCount - 1;
							const separatorWidth = totalTabCount - 1;
							const outerPaddingWidth = 1;
							const tabChromeWidth = 4; // " icon label " minus label width
							const minInactiveLabelWidth = 2;
							const activeRawLabel = currentTab === questions.length ? "Submit" : questions[currentTab]?.label ?? "";
							const reservedForInactive =
								inactiveTabCount * (tabChromeWidth + minInactiveLabelWidth) + separatorWidth + outerPaddingWidth;
							const activeLabelMaxWidth = Math.max(4, maxW - reservedForInactive - tabChromeWidth);
							const activeLabel = shortenLabel(activeRawLabel, activeLabelMaxWidth);
							const remainingInactiveLabelSpace = Math.max(
								0,
								maxW -
									outerPaddingWidth -
									separatorWidth -
									(tabChromeWidth + visibleWidth(activeLabel)) -
									inactiveTabCount * tabChromeWidth,
							);
							const inactiveLabelMaxWidth =
								inactiveTabCount > 0
									? Math.max(minInactiveLabelWidth, Math.floor(remainingInactiveLabelSpace / inactiveTabCount))
									: activeLabelMaxWidth;

							const tabs: string[] = [];
							for (let i = 0; i < questions.length; i++) {
								const isActive = i === currentTab;
								const answered = isAnswered(questions[i]);
								const rawLabel = questions[i].label;
								const lbl = isActive ? activeLabel : shortenLabel(rawLabel, inactiveLabelMaxWidth);
								const icon = answered ? theme.fg("success", SYM.check) : theme.fg("dim", SYM.dot);
								const text = ` ${icon} ${lbl} `;
								tabs.push(
									isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text),
								);
							}
							// Submit tab
							const isSubmitTab = currentTab === questions.length;
							const canSubmit = allRequired();
							const submitLabel = isSubmitTab ? activeLabel : shortenLabel("Submit", inactiveLabelMaxWidth);
							const submitText = ` ${SYM.submit} ${submitLabel} `;
							tabs.push(
								isSubmitTab
									? theme.bg("selectedBg", theme.fg("text", submitText))
									: theme.fg(canSubmit ? "success" : "dim", submitText),
							);
							h.add(` ${tabs.join(theme.fg("dim", "│"))}`);
							head.push("");
						}

						const q = curQ();
						const onSubmitTab = isMulti && currentTab === questions.length;

						if (onSubmitTab) {
							// ── Submit tab: review list (scrollable body) ──────
							h.add(` ${theme.fg("accent", theme.bold("Review & Submit"))}`);
							head.push("");

							const b = into(body);
							for (const question of questions) {
								const label = theme.fg("muted", `${question.label}:`);
								if (question.type === "radio") {
									const a = radioAnswers.get(question.id);
									if (a) {
										const prefix = a.wasCustom ? theme.fg("dim", "(wrote) ") : "";
										b.addWrapped(` ${label} ${prefix}${a.label}`, maxW - 1, " ");
									} else {
										b.add(` ${label} ${theme.fg("warning", "(unanswered)")}`);
									}
								} else if (question.type === "checkbox") {
									const set = checkAnswers.get(question.id) ?? new Set();
									const custom = checkCustom.get(question.id)?.trim();
									const all = [...set];
									if (custom) all.push(`${theme.fg("dim", "(wrote)")} ${custom}`);
									if (all.length) {
										b.addWrapped(` ${label} ${all.join(", ")}`, maxW - 1, " ");
									} else {
										b.add(` ${label} ${theme.fg("warning", "(unanswered)")}`);
									}
								} else {
									const t = textAnswers.get(question.id)?.trim();
									if (t) {
										b.addWrapped(` ${label} ${t}`, maxW - 1, " ");
									} else {
										b.add(` ${label} ${theme.fg("warning", "(unanswered)")}`);
									}
								}
							}
						} else if (q) {
							// ── Question prompt (head) ──────────────────────────
							const typeTag =
								q.type === "radio"
									? theme.fg("dim", "[single-select]")
									: q.type === "checkbox"
										? theme.fg("dim", "[multi-select]")
										: theme.fg("dim", "[text]");

							h.addWrapped(` ${theme.fg("text", theme.bold(q.prompt))} ${typeTag}`, maxW - 1, " ");
							if (q.required) {
								h.add(` ${theme.fg("warning", "*required")}`);
							}
							head.push("");

							// ── Options / editor (scrollable body) ──────────────
							const b = into(body);

							if (q.type === "radio") {
								const selected = radioAnswers.get(q.id);
								for (let i = 0; i < q.options.length; i++) {
									const opt = q.options[i];
									const blockStart = body.length;
									const isCursor = i === cursorIdx;
									const isSelected = selected?.value === opt.value && !selected.wasCustom;
									const bullet = isSelected ? theme.fg("accent", SYM.radioOn) : theme.fg("dim", SYM.radioOff);
									const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
									const color = isCursor ? "accent" : isSelected ? "text" : "muted";
									b.addWrapped(` ${pointer} ${bullet} ${theme.fg(color, opt.label)}`, maxW - 1, " ");
									if (opt.description) {
										b.addWrapped(theme.fg("dim", opt.description), maxW - 6, "      ");
									}
									if (isCursor) {
										cursorStart = blockStart;
										cursorEnd = body.length;
									}
								}
								if (q.allowOther) {
									const blockStart = body.length;
									const isCursor = cursorIdx === q.options.length;
									const isSelected = selected?.wasCustom === true;
									const bullet = isSelected ? theme.fg("accent", SYM.radioOn) : theme.fg("dim", SYM.radioOff);
									const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
									const label = isSelected ? `Other: ${selected.label}` : "Other...";
									b.addWrapped(` ${pointer} ${bullet} ${theme.fg(isCursor ? "accent" : "muted", label)}`, maxW - 1, " ");

									if (isCursor) {
										cursorStart = blockStart;
										if (otherMode) {
											body.push("");
											b.add(` ${theme.fg("muted", "  Your answer:")}`);
											for (const line of editor.render(maxW - 6)) {
												b.add(`   ${line}`);
											}
										}
										cursorEnd = body.length;
									}
								}
							}

							if (q.type === "checkbox") {
								const set = checkAnswers.get(q.id) ?? new Set();
								for (let i = 0; i < q.options.length; i++) {
									const opt = q.options[i];
									const blockStart = body.length;
									const isCursor = i === cursorIdx;
									const isChecked = set.has(opt.value);
									const box = isChecked ? theme.fg("accent", SYM.checkOn) : theme.fg("dim", SYM.checkOff);
									const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
									const color = isCursor ? "accent" : isChecked ? "text" : "muted";
									b.addWrapped(` ${pointer} ${box} ${theme.fg(color, opt.label)}`, maxW - 1, " ");
									if (opt.description) {
										b.addWrapped(theme.fg("dim", opt.description), maxW - 6, "      ");
									}
									if (isCursor) {
										cursorStart = blockStart;
										cursorEnd = body.length;
									}
								}
								if (q.allowOther) {
									const blockStart = body.length;
									const isCursor = cursorIdx === q.options.length;
									const custom = checkCustom.get(q.id)?.trim();
									const box = custom ? theme.fg("accent", SYM.checkOn) : theme.fg("dim", SYM.checkOff);
									const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
									const label = custom ? `Other: ${custom}` : "Other...";
									b.addWrapped(` ${pointer} ${box} ${theme.fg(isCursor ? "accent" : "muted", label)}`, maxW - 1, " ");

									if (isCursor) {
										cursorStart = blockStart;
										if (otherMode) {
											body.push("");
											b.add(` ${theme.fg("muted", "  Your answer:")}`);
											for (const line of editor.render(maxW - 6)) {
												b.add(`   ${line}`);
											}
										}
										cursorEnd = body.length;
									}
								}
							}

							if (q.type === "text") {
								if (q.placeholder && !editor.getText()) {
									b.addWrapped(` ${theme.fg("dim", q.placeholder)}`, maxW - 1, " ");
								}
								for (const line of editor.render(maxW - 4)) {
									b.add(`  ${line}`);
								}
							}
						}

						// ── Window the body so head + window + tail ≤ maxFormLines ──
						// Fixed tail size: blank + hints + hr (submit tab adds the
						// submit/required line plus a second blank).
						const tailLen = onSubmitTab ? 5 : 3;
						const visible = Math.max(1, maxFormLines - head.length - tailLen);
						let winStart = 0;
						let clipped = false;
						if (body.length > visible) {
							clipped = true;
							const maxStart = body.length - visible;
							if (onSubmitTab) {
								winStart = Math.min(Math.max(0, submitScroll), maxStart);
								submitScroll = winStart;
							} else if (q?.type === "text") {
								// Text answers grow at the end; keep the tail end visible.
								winStart = maxStart;
							} else if (cursorStart >= 0) {
								// Minimal scrolling: only move the window when the cursor
								// block leaves it.
								winStart = Math.min(Math.max(0, scrollWinStart), maxStart);
								if (cursorStart < winStart) {
									winStart = cursorStart;
								} else if (cursorEnd > winStart + visible) {
									winStart = Math.min(maxStart, cursorEnd - visible);
								}
								winStart = Math.min(Math.max(0, winStart), maxStart);
								scrollWinStart = winStart;
							} else {
								winStart = Math.min(Math.max(0, scrollWinStart), maxStart);
								scrollWinStart = winStart;
							}
						} else if (onSubmitTab) {
							submitScroll = 0;
						} else {
							scrollWinStart = 0;
						}
						const above = winStart;
						const below = Math.max(0, body.length - winStart - visible);
						const scrollNote = clipped
							? ` • ⋮${above > 0 ? ` ↑${above}` : ""}${below > 0 ? ` ↓${below} more` : ""} (↑↓ scroll)`
							: "";

						// ── Footer (tail) ────────────────────────────────────
						const t = into(tail);
						tail.push("");
						if (onSubmitTab) {
							if (allRequired()) {
								t.add(` ${theme.fg("success", "Press Enter to submit")}`);
							} else {
								const missing = questions
									.filter((q) => q.required && !isAnswered(q))
									.map((q) => q.label)
									.join(", ");
								t.add(` ${theme.fg("warning", `Required: ${missing}`)}`);
							}
							tail.push("");
							t.add(theme.fg("dim", ` Tab/←→ navigate questions • Enter submit • Esc cancel${scrollNote}`));
						} else if (q) {
							if (otherMode) {
								t.add(theme.fg("dim", ` Enter submit • Esc go back${scrollNote}`));
							} else if (q.type === "text") {
								const nav = isMulti ? "Tab/←→ navigate • " : "";
								t.add(theme.fg("dim", ` ${nav}Enter submit • Esc cancel${scrollNote}`));
							} else if (q.type === "checkbox") {
								const nav = isMulti ? "Tab/←→ navigate • " : "";
								t.add(theme.fg("dim", ` ↑↓ navigate • Space toggle • ${nav}Enter ${isMulti ? "next" : "submit"} • Esc cancel${scrollNote}`));
							} else {
								const nav = isMulti ? "Tab/←→ navigate • " : "";
								t.add(theme.fg("dim", ` ↑↓ navigate • ${nav}Enter select • Esc cancel${scrollNote}`));
							}
						}
						hr(tail);

						const lines = [...head, ...body.slice(winStart, winStart + visible), ...tail];
						cachedLines = lines;
						cachedWidth = width;
						cachedRows = rows;
						return lines;
					}
					const firstQ = questions[0];
					if (firstQ?.type === "text") {
						editor.setText(textAnswers.get(firstQ.id) ?? "");
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
					// Render in the document flow (pi's editor-replacement custom-UI mode):
					// the form sits BELOW the transcript, so the most recent messages stay
					// visible directly above it. render() caps the form height to the
					// terminal (see maxFormLines), which also keeps the working spinner
					// inside the TUI viewport — preventing the full-screen-repaint flicker
					// that otherwise occurs on every spinner tick while the form is open.
				});
			} finally {
				pi.events.emit("herdr:blocked", { active: false });
			}

			// ctx.ui.custom resolves undefined when no real UI can render (e.g. RPC mode)
			if (result === undefined) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}

			// ── Format result ────────────────────────────────────────────

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the form" }],
					details: result,
				};
			}

			const answerLines: string[] = [];
			for (const a of result.answers) {
				const q = questions.find((q) => q.id === a.id);
				const label = q?.label || a.id;
				if (a.type === "radio") {
					const prefix = a.wasCustom ? "(wrote) " : "";
					answerLines.push(`${label}: ${prefix}${a.value}`);
				} else if (a.type === "checkbox") {
					const values = Array.isArray(a.value) ? a.value : [a.value];
					if (values.length === 0) {
						answerLines.push(`${label}: (none selected)`);
					} else {
						answerLines.push(`${label}: ${values.join(", ")}`);
					}
				} else {
					answerLines.push(`${label}: ${a.value || "(empty)"}`);
				}
			}

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		// ── Custom rendering ─────────────────────────────────────────────

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const title = args.title as string | undefined;
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			if (title) {
				text += theme.fg("accent", title) + " ";
			}
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			const types = [...new Set(qs.map((q) => q.type))].join(", ");
			if (types) {
				text += theme.fg("dim", ` (${types})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as FormResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((a) => {
				const q = details.questions.find((q) => q.id === a.id);
				const label = q?.label || a.id;

				if (a.type === "radio") {
					const prefix = a.wasCustom ? theme.fg("dim", "(wrote) ") : "";
					return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${prefix}${a.value}`;
				}
				if (a.type === "checkbox") {
					const values = Array.isArray(a.value) ? a.value : [a.value];
					const display = values.length ? values.join(", ") : theme.fg("dim", "(none)");
					return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${display}`;
				}
				return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${a.value || theme.fg("dim", "(empty)")}`;
			});

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
