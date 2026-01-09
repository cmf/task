/**
 * Task Extension - Deterministic task workflow for jj workspaces
 *
 * Provides /task command that detects workspace type:
 * - Main workspace: handles merge/cleanup of completed task workspaces, task selection
 * - Task workspace: handles active task work
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getMarkdownTheme,
	getSelectListTheme,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { invokeAgentWithUI, registerSubagentRenderer } from "@cmf/pi-subagent";
import {
	Container,
	Editor,
	Input,
	Markdown,
	SelectList,
	Spacer,
	Text,
	matchesKey,
	truncateToWidth,
} from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export default function (pi: ExtensionAPI) {
	registerSubagentRenderer(pi);
	registerPromptTools(pi);

	// pi.registerCommand("subagent-test", {
	// 	description: "Test subagent infrastructure",
	// 	handler: async (args, ctx) => {
	// 		await invokeAgentWithUI(ctx, pi, {
	// 			step: {
	// 				chain: [
	// 					{
	// 						parallel: [
	// 							// Chain 1: Code analysis
	// 							{
	// 								chain: [
	// 									{ cwd: ctx.cwd, agent: "scout", task: "Find TypeScript files", label: "Find TS" },
	// 									{ cwd: ctx.cwd, agent: "reviewer", task: "Review the code structure:\n\n{previous}", label: "Review code" },
	// 								],
	// 								label: "Code analysis",
	// 							},
	// 							// Chain 2: Documentation analysis
	// 							{
	// 								chain: [
	// 									{ cwd: ctx.cwd, agent: "scout", task: "Find markdown and config files", label: "Find docs" },
	// 									{ cwd: ctx.cwd, agent: "reviewer", task: "Review the documentation quality:\n\n{previous}", label: "Review docs" },
	// 								],
	// 								label: "Docs analysis",
	// 							},
	// 						],
	// 						label: "Parallel analysis",
	// 					},
	// 					// Final synthesis
	// 					{
	// 						cwd: ctx.cwd,
	// 						agent: "planner",
	// 						task: "Synthesize these analyses into a prioritized improvement plan:\n\n{previous}",
	// 						label: "Synthesize",
	// 					},
	// 				],
	// 			},
	// 		});
	// 	},
	// });

	pi.registerCommand("task", {
		description: "Run the deterministic task workflow",
		handler: async (_args, ctx) => {
			// Check required commands
			for (const cmd of ["jj", "tk", "jq"]) {
				const result = await pi.exec("which", [cmd]);
				if (result.code !== 0) {
					ctx.ui.notify(`Missing required command: ${cmd}`, "error");
					return;
				}
			}

			// Check if we're in a jj workspace
			const jjRootResult = await pi.exec("jj", ["root"]);
			if (jjRootResult.code !== 0) {
				ctx.ui.notify("Not in a jj workspace (jj root failed)", "error");
				return;
			}
			const root = jjRootResult.stdout.trim();

			// Determine workspace type and run appropriate flow
			if (isTaskWorkspace(root)) {
				await runTaskWorkspace(pi, ctx, root);
			} else {
				await runMainWorkspace(pi, ctx, root);
			}
		},
	});
}

interface PromptToolBase {
	description: string;
	prompt: string;
	timeoutMs?: number;
}

interface ConfirmToolDetails {
	description: string;
	prompt: string;
	confirmed: boolean;
	cancelled: boolean;
}

interface SelectToolDetails {
	description: string;
	prompt: string;
	options: string[];
	selection: string | null;
}

interface MultiSelectItem {
	item: string;
	selected?: boolean;
}

interface MultiSelectToolDetails {
	description: string;
	prompt: string;
	items: MultiSelectItem[];
	selectedItems: string[];
	cancelled: boolean;
}

interface InputToolDetails {
	description: string;
	prompt: string;
	placeholder?: string;
	text: string | null;
}

interface EditorToolDetails {
	description: string;
	prompt: string;
	prefill?: string;
	text: string | null;
}

const PromptToolBaseSchema = {
	description: Type.String({
		description: "Markdown context block shown before prompting the user.",
	}),
	prompt: Type.String({
		description: "Single-line prompt shown in the dialog title.",
	}),
	timeoutMs: Type.Optional(
		Type.Number({ description: "Timeout in milliseconds before auto-cancelling the dialog." }),
	),
};

const ConfirmToolParams = Type.Object({
	...PromptToolBaseSchema,
});

const SelectToolParams = Type.Object({
	...PromptToolBaseSchema,
	options: Type.Array(Type.String(), { description: "Options the user can choose from." }),
});

const MultiSelectToolParams = Type.Object({
	...PromptToolBaseSchema,
	items: Type.Array(
		Type.Object({
			item: Type.String({ description: "Item label to display." }),
			selected: Type.Optional(Type.Boolean({ description: "Whether the item is pre-selected." })),
		}),
		{ description: "Items to toggle with optional pre-selected state (default: true)." },
	),
});

const InputToolParams = Type.Object({
	...PromptToolBaseSchema,
	placeholder: Type.Optional(Type.String({ description: "Placeholder shown in the input field." })),
});

const EditorToolParams = Type.Object({
	description: PromptToolBaseSchema.description,
	prompt: PromptToolBaseSchema.prompt,
	prefill: Type.Optional(Type.String({ description: "Initial text to seed the editor." })),
});

function registerPromptTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "confirm",
		label: "Confirm",
		description:
			"Show context to the user and ask for confirmation. Use when you need an explicit yes/no decision.",
		parameters: ConfirmToolParams,
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						description: params.description,
						prompt: params.prompt,
						confirmed: false,
						cancelled: true,
					} as ConfirmToolDetails,
				};
			}

			const title = buildPromptTitle(params.description, params.prompt);
			const confirmed = await runConfirmDialog(ctx, title, params.timeoutMs);

			if (confirmed === undefined) {
				ctx.abort();
			}

			return {
				content: [
					{
						type: "text",
						text: confirmed ? "User confirmed" : "User declined or cancelled",
					},
				],
				details: {
					description: params.description,
					prompt: params.prompt,
					confirmed,
					cancelled: !confirmed,
				} as ConfirmToolDetails,
			};
		},
	});

	pi.registerTool({
		name: "select",
		label: "Select",
		description:
			"Show context to the user and ask them to select from options. Use when the agent needs a discrete choice.",
		parameters: SelectToolParams,
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						description: params.description,
						prompt: params.prompt,
						options: params.options,
						selection: null,
					} as SelectToolDetails,
				};
			}

			if (params.options.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No options provided" }],
					details: {
						description: params.description,
						prompt: params.prompt,
						options: [],
						selection: null,
					} as SelectToolDetails,
				};
			}

			const title = buildPromptTitle(params.description, params.prompt);
			const selection = await runSelectDialog(ctx, title, params.options, params.timeoutMs);

			if (selection === undefined) {
				ctx.abort();
			}

			return {
				content: [
					{
						type: "text",
						text: selection ? `User selected: ${selection}` : "User cancelled the selection",
					},
				],
				details: {
					description: params.description,
					prompt: params.prompt,
					options: params.options,
					selection: selection ?? null,
				} as SelectToolDetails,
			};
		},
	});

	pi.registerTool({
		name: "multi_select",
		label: "Multi Select",
		description:
			"Show context to the user and ask them to toggle multiple items. Use when the agent needs multiple selections.",
		parameters: MultiSelectToolParams,
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						description: params.description,
						prompt: params.prompt,
						items: params.items,
						selectedItems: [],
						cancelled: true,
					} as MultiSelectToolDetails,
				};
			}

			if (params.items.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No items provided" }],
					details: {
						description: params.description,
						prompt: params.prompt,
						items: [],
						selectedItems: [],
						cancelled: true,
					} as MultiSelectToolDetails,
				};
			}

			const title = buildPromptTitle(params.description, params.prompt);
			const selectedItems = await runMultiSelectDialog(ctx, title, params.items, params.timeoutMs);

			if (selectedItems === undefined) {
				ctx.abort();
			}

			const cancelled = selectedItems === undefined;
			const selectedSummary = cancelled
				? "User cancelled the selection"
				: selectedItems.length > 0
					? `User selected: ${selectedItems.join(", ")}`
					: "User selected: (none)";

			return {
				content: [
					{
						type: "text",
						text: selectedSummary,
					},
				],
				details: {
					description: params.description,
					prompt: params.prompt,
					items: params.items,
					selectedItems: cancelled ? [] : selectedItems,
					cancelled,
				} as MultiSelectToolDetails,
			};
		},
	});

	pi.registerTool({
		name: "input",
		label: "Input",
		description:
			"Show context to the user and ask for text input. Use when the agent needs a short string response.",
		parameters: InputToolParams,
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						description: params.description,
						prompt: params.prompt,
						placeholder: params.placeholder,
						text: null,
					} as InputToolDetails,
				};
			}

			const title = buildPromptTitle(params.description, params.prompt);
			const text = await runInputDialog(ctx, title, params.placeholder, params.timeoutMs);

			if (text === undefined) {
				ctx.abort();
			}

			return {
				content: [
					{
						type: "text",
						text: text !== undefined ? `User input: ${text}` : "User cancelled the input",
					},
				],
				details: {
					description: params.description,
					prompt: params.prompt,
					placeholder: params.placeholder,
					text: text ?? null,
				} as InputToolDetails,
			};
		},
	});

	pi.registerTool({
		name: "editor",
		label: "Editor",
		description:
			"Show context to the user and open a multi-line editor. Use when the agent needs longer-form text.",
		parameters: EditorToolParams,
		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: {
						description: params.description,
						prompt: params.prompt,
						prefill: params.prefill,
						text: null,
					} as EditorToolDetails,
				};
			}

			const text = await runEditorDialog(ctx, params);

			if (text === undefined) {
				ctx.abort();
			}

			return {
				content: [
					{
						type: "text",
						text: text !== undefined ? formatEditorToolContent(text) : "User cancelled the editor",
					},
				],
				details: {
					description: params.description,
					prompt: params.prompt,
					prefill: params.prefill,
					text: text ?? null,
				} as EditorToolDetails,
			};
		},
	});
}

function buildPromptTitle(description: string, prompt: string): string {
	const trimmed = description.trim();
	return trimmed ? `${trimmed}\n\n${prompt}` : prompt;
}

function formatEditorToolContent(text: string): string {
	if (text.trim().length === 0) {
		return "(empty)";
	}

	const truncation = truncateHead(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	if (!truncation.truncated) {
		return truncation.content;
	}

	return `${truncation.content}\n\n[Content truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
}

function createTimedDone<T>(done: (value: T) => void, timeoutMs?: number): (value: T) => void {
	let resolved = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	if (timeoutMs) {
		timeoutId = setTimeout(() => {
			if (resolved) return;
			resolved = true;
			done(undefined as T);
		}, timeoutMs);
	}

	return (value: T) => {
		if (resolved) return;
		resolved = true;
		if (timeoutId) clearTimeout(timeoutId);
		done(value);
	};
}

async function runConfirmDialog(
	ctx: ExtensionContext,
	title: string,
	timeoutMs?: number,
): Promise<boolean | undefined> {
	const choice = await runSelectDialog(ctx, title, ["Yes", "No"], timeoutMs);
	if (choice === undefined) return undefined;
	return choice === "Yes";
}

async function runSelectDialog(
	ctx: ExtensionContext,
	title: string,
	options: string[],
	timeoutMs?: number,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const finish = createTimedDone(done, timeoutMs);
		const container = new Container();
		const mdTheme = getMarkdownTheme();
		const markdown = new Markdown(title, 1, 1, mdTheme);
		const items = options.map((option) => ({ value: option, label: option }));
		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());

		selectList.onSelect = (item) => finish(item.value);
		selectList.onCancel = () => finish(undefined);

		container.addChild(markdown);
		container.addChild(new Spacer(1));
		container.addChild(selectList);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate  enter select  esc cancel"), 1, 0));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function runMultiSelectDialog(
	ctx: ExtensionContext,
	title: string,
	items: MultiSelectItem[],
	timeoutMs?: number,
): Promise<string[] | undefined> {
	type InternalItem = { label: string; selected: boolean };

	return ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
		const finish = createTimedDone(done, timeoutMs);
		const normalized: InternalItem[] = items.map((item) => ({
			label: item.item,
			selected: item.selected ?? true,
		}));

		let selectedIndex = 0;
		const container = new Container();
		const mdTheme = getMarkdownTheme();
		const markdown = new Markdown(title, 1, 1, mdTheme);

		const maxVisible = Math.min(normalized.length, 10);

		const renderList = (width: number): string[] => {
			const lines: string[] = [];
			const startIndex = Math.max(
				0,
				Math.min(selectedIndex - Math.floor(maxVisible / 2), normalized.length - maxVisible),
			);
			const endIndex = Math.min(startIndex + maxVisible, normalized.length);

			for (let i = startIndex; i < endIndex; i++) {
				const item = normalized[i];
				if (!item) continue;
				const isSelected = i === selectedIndex;
				const checkbox = item.selected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
				const label = isSelected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
				const line = `${prefix}${checkbox} ${label}`;
				lines.push(truncateToWidth(line, width));
			}

			return lines;
		};

		container.addChild(markdown);
		container.addChild(new Spacer(1));
		container.addChild({
			render: (width: number) => renderList(width),
			invalidate: () => {},
		});
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate  space toggle  enter submit  esc cancel"), 1, 0));

		const submit = () => {
			finish(normalized.filter((item) => item.selected).map((item) => item.label));
		};

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					finish(undefined);
					return;
				}
				if (matchesKey(data, "up")) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "down")) {
					selectedIndex = Math.min(normalized.length - 1, selectedIndex + 1);
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "space")) {
					const current = normalized[selectedIndex];
					if (current) current.selected = !current.selected;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "enter")) {
					submit();
					return;
				}
			},
		};
	});
}

async function runInputDialog(
	ctx: ExtensionContext,
	title: string,
	placeholder?: string,
	timeoutMs?: number,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const finish = createTimedDone(done, timeoutMs);
		const container = new Container();
		const mdTheme = getMarkdownTheme();
		const markdown = new Markdown(title, 1, 1, mdTheme);
		const input = new Input();

		input.onSubmit = (value) => finish(value);
		input.onEscape = () => finish(undefined);

		container.addChild(markdown);
		container.addChild(new Spacer(1));
		container.addChild(input);
		container.addChild(new Spacer(1));
		if (placeholder) {
			container.addChild(new Text(theme.fg("dim", `placeholder: ${placeholder}`), 1, 0));
		}
		container.addChild(new Text(theme.fg("dim", "enter submit  esc cancel"), 1, 0));

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				input.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function runEditorDialog(ctx: ExtensionContext, params: { description: string; prompt: string; prefill?: string })
	: Promise<string | undefined> {
	const title = buildPromptTitle(params.description, params.prompt);

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const finish = createTimedDone(done);
		const container = new Container();
		const mdTheme = getMarkdownTheme();
		const markdown = new Markdown(title, 1, 1, mdTheme);

		const editorTheme = {
			borderColor: (value: string) => theme.fg("borderMuted", value),
			selectList: getSelectListTheme(),
		};
		const editor = new Editor(editorTheme);
		editor.disableSubmit = true;
		if (params.prefill) {
			editor.setText(params.prefill);
		}

		container.addChild(markdown);
		container.addChild(new Spacer(1));
		container.addChild(editor);
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(
				theme.fg("dim", "enter newline  ctrl+s submit  esc cancel"),
				1,
				0,
			),
		);

		const submit = () => {
			finish(editor.getText());
		};

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
					finish(undefined);
					return;
				}

				if (matchesKey(data, "ctrl+s")) {
					submit();
					return;
				}

				if (matchesKey(data, "enter") || data === "\r" || data === "\n" || data === "\x1bOM") {
					editor.handleInput("\n");
					tui.requestRender();
					return;
				}

				editor.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/**
 * Main workspace flow:
 * 1. Check for completed task workspaces and offer to merge
 * 2. Select a task from `tk ready`
 * 3. Create task workspace
 */
async function runMainWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string
): Promise<void> {
	// Loop: merge completed workspaces
	while (await maybeMergeCompletedWorkspace(pi, ctx, root)) {
		// Continue merging until none left or user skips
	}

	// Select and start a new task
	await selectAndStartTask(pi, ctx, root);
}

/**
 * Task workspace flow (placeholder for now)
 */
async function runTaskWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string
): Promise<void> {
	ctx.ui.notify("task workspace - not yet implemented", "info");
}

/**
 * Check for completed task workspaces and offer to merge one
 * Returns true if a merge happened (so caller can loop)
 */
async function maybeMergeCompletedWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string
): Promise<boolean> {
	const workspaceNames = await listWorkspaceNames(pi, ctx);
	if (workspaceNames.length === 0) {
		return false;
	}

	const repo = path.basename(root);
	const mainCommitId = await getMainWorkspaceCommitId(pi, ctx);
	if (!mainCommitId) {
		return false;
	}

	const mergeableWorkspaces: Array<{ name: string; wsPath: string }> = [];
	for (const name of workspaceNames) {
		if (name === "default") {
			continue;
		}

		const wsPath = path.join(os.homedir(), ".workspaces", name, repo);
		if (!fs.existsSync(wsPath)) {
			continue;
		}

		const inProgress = await listInProgressTaskIds(pi, wsPath);
		if (inProgress.size > 0) {
			continue;
		}

		const hasUnmerged = await workspaceHasUnmergedCommits(pi, ctx, wsPath, mainCommitId);
		if (!hasUnmerged) {
			continue;
		}

		mergeableWorkspaces.push({ name, wsPath });
	}

	if (mergeableWorkspaces.length === 0) {
		return false;
	}

	const choices = mergeableWorkspaces.map((ws) => ws.name);
	choices.push("Skip merge");

	const selection = await ctx.ui.select(
		"Task workspaces ready to merge:",
		choices
	);

	if (!selection || selection === "Skip merge") {
		return false;
	}

	const selected = mergeableWorkspaces.find((ws) => ws.name === selection);
	if (!selected) {
		return false;
	}

	const confirmMerge = await ctx.ui.confirm(
		"Merge workspace?",
		`Merge "${selected.name}" into main?`
	);

	if (!confirmMerge) {
		return false;
	}

	const mergeSuccess = await mergeDoneTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
	if (!mergeSuccess) {
		return false;
	}

	ctx.ui.notify(`Merged workspace: ${selected.name}`, "info");

	const confirmDelete = await ctx.ui.confirm(
		"Delete workspace?",
		`Delete jj workspace "${selected.name}"?`
	);

	if (confirmDelete) {
		await deleteTaskWorkspace(pi, ctx, root, selected.name, selected.wsPath);
		ctx.ui.notify(`Deleted workspace: ${selected.name}`, "info");
	}

	return true;
}

/**
 * Merge a completed task workspace into main
 */
async function mergeDoneTaskWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string,
	name: string,
	wsPath: string
): Promise<boolean> {
	// Get the change ID from the task workspace (the actual work commit)
	const changeIdResult = await pi.exec("jj", [
		"log",
		"-R", wsPath,
		"--ignore-working-copy",
		"-r", "@-",
		"-T", "change_id",
		"--no-graph",
	]);

	if (changeIdResult.code !== 0 || !changeIdResult.stdout.trim()) {
		ctx.ui.notify(`Failed to get change ID for ${name}`, "error");
		return false;
	}

	const taskChangeId = changeIdResult.stdout.trim();

	// Rebase the task work commit onto the current working copy parent
	const rebase1 = await pi.exec("jj", ["rebase", "-s", taskChangeId, "-d", "@-"]);
	if (rebase1.code !== 0) {
		ctx.ui.notify(`Rebase failed: ${rebase1.stderr}`, "error");
		return false;
	}

	// Rebase working copy on top of the merged changes
	const rebase2 = await pi.exec("jj", ["rebase", "-s", "@", "-d", taskChangeId]);
	if (rebase2.code !== 0) {
		ctx.ui.notify(`Rebase working copy failed: ${rebase2.stderr}`, "error");
		return false;
	}

	return true;
}

async function listWorkspaceNames(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext
): Promise<string[]> {
	const wsListResult = await pi.exec("jj", ["workspace", "list"]);
	if (wsListResult.code !== 0) {
		ctx.ui.notify("Failed to list workspaces", "error");
		return [];
	}

	return wsListResult.stdout
		.split("\n")
		.map((line) => line.replace(/:.*$/, "").trim())
		.filter((name) => name.length > 0);
}

async function getMainWorkspaceCommitId(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext
): Promise<string> {
	const result = await pi.exec("jj", [
		"log",
		"-r",
		"@-",
		"-T",
		"commit_id",
		"--no-graph",
		"--limit",
		"1",
	]);
	if (result.code !== 0 || !result.stdout.trim()) {
		ctx.ui.notify("Failed to read main workspace head", "error");
		return "";
	}

	return result.stdout.trim();
}

async function workspaceHasUnmergedCommits(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	wsPath: string,
	mainCommitId: string
): Promise<boolean> {
	const revset = `@- & ~ancestors(${mainCommitId})`;
	const result = await pi.exec("jj", [
		"log",
		"-R",
		wsPath,
		"-r",
		revset,
		"-T",
		"change_id",
		"--no-graph",
		"--limit",
		"1",
	]);

	if (result.code !== 0) {
		ctx.ui.notify(`Failed to check workspace commits: ${wsPath}`, "error");
		return false;
	}

	return result.stdout.trim().length > 0;
}

async function listInProgressTaskIds(
	pi: ExtensionAPI,
	wsPath: string
): Promise<Set<string>> {
	const tkResult = await pi.exec("tk", ["query", "select(.status == \"in_progress\")"], {
		cwd: wsPath,
	});

	if (tkResult.code !== 0) {
		return new Set();
	}

	return new Set(parseTkQueryIds(tkResult.stdout));
}

async function listInProgressTaskIdsAcrossWorkspaces(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string
): Promise<Set<string>> {
	const workspaceNames = await listWorkspaceNames(pi, ctx);
	const repo = path.basename(root);
	const ids = new Set<string>();

	for (const name of workspaceNames) {
		if (name === "default") {
			continue;
		}

		const wsPath = path.join(os.homedir(), ".workspaces", name, repo);
		if (!fs.existsSync(wsPath)) {
			continue;
		}

		const workspaceIds = await listInProgressTaskIds(pi, wsPath);
		for (const id of workspaceIds) {
			ids.add(id);
		}
	}

	return ids;
}

function parseTkQueryIds(output: string): string[] {
	const trimmed = output.trim();
	if (!trimmed) {
		return [];
	}

	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (Array.isArray(parsed)) {
			return parsed
				.map((item) => (item && typeof item === "object" ? (item as { id?: string }).id : ""))
				.filter((id): id is string => typeof id === "string" && id.length > 0);
		}
		if (parsed && typeof parsed === "object") {
			const id = (parsed as { id?: string }).id;
			return typeof id === "string" && id.length > 0 ? [id] : [];
		}
	} catch {
		// Fall through to line-based parsing.
	}

	return trimmed
		.split("\n")
		.map((line) => {
			try {
				const parsed = JSON.parse(line) as { id?: string };
				return typeof parsed.id === "string" ? parsed.id : "";
			} catch {
				const match = line.match(/\b(tp-[a-z0-9]+)\b/);
				return match ? match[1] : "";
			}
		})
		.filter((id) => id.length > 0);
}

function parseTicketIdFromReadyLine(line: string): string {
	const match = line.match(/\b(tp-[a-z0-9]+)\b/);
	return match ? match[1] : "";
}

/**
 * Delete a task workspace (jj forget + rm directory)
 */
async function deleteTaskWorkspace(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string,
	name: string,
	wsPath: string
): Promise<void> {
	// Forget the workspace in jj
	await pi.exec("jj", ["workspace", "forget", name]);

	// Safety check: ensure wsPath is under ~/.workspaces/<task-id>/<repo>
	const repo = path.basename(root);
	const normalizedPath = stripPrivatePrefix(wsPath);
	const normalizedHome = stripPrivatePrefix(os.homedir());
	const base = path.join(normalizedHome, ".workspaces");
	const rel = path.relative(base, normalizedPath);
	const parts = rel.split(path.sep).filter(Boolean);

	if (rel.startsWith("..") || path.isAbsolute(rel) || parts.length !== 2 || parts[1] !== repo) {
		ctx.ui.notify(`Refusing to delete non-workspace path: ${wsPath}`, "error");
		return;
	}

	// Delete the task ID directory (parent of wsPath)
	const taskIdDir = path.dirname(wsPath);
	if (fs.existsSync(taskIdDir)) {
		fs.rmSync(taskIdDir, { recursive: true, force: true });
	}
}

/**
 * Select a task from `tk ready` and create a workspace for it
 */
async function selectAndStartTask(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	root: string
): Promise<void> {
	// Get ready tasks (open only, not in_progress)
	const tkResult = await pi.exec("tk", ["ready"]);
	if (tkResult.code !== 0) {
		ctx.ui.notify("Failed to get ready tasks", "error");
		return;
	}

	const inProgressTaskIds = await listInProgressTaskIdsAcrossWorkspaces(pi, ctx, root);

	// Filter out in_progress tasks - only show open ones for selection
	const readyLines = tkResult.stdout
		.trim()
		.split("\n")
		.filter((line) => line && line.includes("[open]"))
		.filter((line) => {
			const id = parseTicketIdFromReadyLine(line);
			return !id || !inProgressTaskIds.has(id);
		});
	if (readyLines.length === 0) {
		ctx.ui.notify("No open tasks found. Create tickets with `tk create`", "info");
		return;
	}

	// Let user select a task
	const selection = await ctx.ui.select("Select a task to start:", readyLines);
	if (!selection) {
		return;
	}

	// Parse the ticket ID and title from the selection (format: "tp-xxxx  [P2][open] - Title")
	const ticketId = selection.split(/\s+/)[0];
	if (!ticketId) {
		ctx.ui.notify("Failed to parse ticket ID", "error");
		return;
	}

	// Extract title from the selection line (after " - ")
	const titleMatch = selection.match(/ - (.+)$/);
	const ticketTitle = titleMatch ? titleMatch[1] : ticketId;

	// Create slug from title
	const slugDefault = slugify(ticketTitle);
	const slug = await ctx.ui.input(`Task slug (default: ${slugDefault}):`, slugDefault) || slugDefault;

	// Create task ID with timestamp (needed for commit message)
	const taskId = `${formatTaskIdTimestamp(new Date())}-${slug}`;

	// Create workspace path
	const repo = path.basename(root);
	const wsPath = path.join(os.homedir(), ".workspaces", taskId, repo);

	// Create parent directory
	fs.mkdirSync(path.dirname(wsPath), { recursive: true });

	// Create jj workspace from the current main commit
	const wsAddResult = await pi.exec("jj", [
		"workspace", "add",
		"--name", taskId,
		"-r", "@-",
		wsPath,
	]);

	if (wsAddResult.code !== 0) {
		ctx.ui.notify(`Failed to create workspace: ${wsAddResult.stderr}`, "error");
		return;
	}

	// Set the ticket to in_progress in the task workspace
	const startResult = await pi.exec("tk", ["start", ticketId], { cwd: wsPath });
	if (startResult.code !== 0) {
		ctx.ui.notify(`Failed to set ticket to in_progress: ${startResult.stderr}`, "error");
		return;
	}

	// Display success message
	ctx.ui.notify(`Task workspace created: ${wsPath}`, "info");

	// If we're in tmux, create a new window and run pi there
	if (process.env.TMUX) {
		await pi.exec("tmux", ["new-window", "-n", slug, "-c", wsPath]);
		await pi.exec("tmux", ["send-keys", "pi", "Enter"]);
		ctx.ui.notify(`Opened tmux window: ${slug}`, "info");
	} else {
		ctx.ui.notify(`Next: cd ${wsPath} && pi`, "info");
	}
}

/**
 * Check if we're in a task workspace (under ~/.workspaces/<task-id>/<repo-name>)
 */
function isTaskWorkspace(root: string): boolean {
	const repo = path.basename(root);
	const normalizedRoot = stripPrivatePrefix(path.resolve(root));
	const normalizedHome = stripPrivatePrefix(os.homedir());
	const base = path.join(normalizedHome, ".workspaces");
	const rel = path.relative(base, normalizedRoot);

	// If rel starts with ".." or is absolute, we're not under .workspaces
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return false;
	}

	// Check structure: should be <task-id>/<repo-name>
	const parts = rel.split(path.sep).filter(Boolean);
	return parts.length === 2 && parts[1] === repo;
}

/**
 * Strip /private prefix (macOS symlink resolution)
 */
function stripPrivatePrefix(value: string): string {
	if (value.startsWith("/private")) {
		return value.slice("/private".length) || "/";
	}
	return value;
}

/**
 * Create a URL-friendly slug from a title
 */
function slugify(title: string): string {
	let value = title.toLowerCase();
	value = value.replace(/[^a-z0-9]+/g, "-");
	value = value.replace(/^-+|-+$/g, "");
	value = value.replace(/-+/g, "-");
	return value || "task";
}

/**
 * Format a date as YYYYMMDD-HHMMSS for task IDs
 */
function formatTaskIdTimestamp(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	const year = date.getFullYear();
	const month = pad(date.getMonth() + 1);
	const day = pad(date.getDate());
	const hours = pad(date.getHours());
	const minutes = pad(date.getMinutes());
	const seconds = pad(date.getSeconds());
	return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}
