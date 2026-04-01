import type {
	BashToolDetails,
	EditToolDetails,
	ExtensionAPI,
	FindToolDetails,
	GrepToolDetails,
	LsToolDetails,
	ReadToolDetails,
} from "@mariozechner/pi-coding-agent";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { homedir } from "os";

function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function arrow(theme: any, label: string) {
	return theme.fg("toolTitle", "→ ") + theme.fg("toolTitle", theme.bold(label));
}

function formatKvArgs(args: Array<[string, unknown]>): string {
	const parts = args
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}=${value}`);
	return parts.length ? ` [${parts.join(", ")}]` : "";
}

function renderDiff(theme: any, diff: string, maxLines: number = 40): Text {
	const diffLines = diff.split("\n");
	let added = 0;
	let removed = 0;
	for (const line of diffLines) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}

	const visibleDiffLines = diffLines.slice(0, maxLines).map((line) => {
		if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
		if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
		return theme.fg("toolDiffContext", line);
	});

	let text = theme.fg("success", `+${added}`) + theme.fg("dim", " / ") + theme.fg("error", `-${removed}`);
	text += "\n" + visibleDiffLines.join("\n");
	if (diffLines.length > maxLines) {
		text += "\n" + theme.fg("muted", `... ${diffLines.length - maxLines} more diff lines`);
	}
	return new Text(text, 0, 0);
}

async function createUnifiedDiff(path: string, before: string, after: string): Promise<string | undefined> {
	if (before === after) return undefined;

	const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const beforePath = join(tmpdir(), `pi-minimal-before-${id}`);
	const afterPath = join(tmpdir(), `pi-minimal-after-${id}`);

	try {
		await writeFile(beforePath, before, "utf8");
		await writeFile(afterPath, after, "utf8");
		try {
			const output = execFileSync("diff", ["-u", "--label", `${path} (before)`, "--label", `${path} (after)`, beforePath, afterPath], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			return output;
		} catch (error: any) {
			if (typeof error?.stdout === "string" && error.stdout.length > 0) {
				return error.stdout;
			}
			return undefined;
		}
	} finally {
		await Promise.allSettled([rm(beforePath, { force: true }), rm(afterPath, { force: true })]);
	}
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const readTool = createReadTool(cwd);
	const bashTool = createBashTool(cwd);
	const editTool = createEditTool(cwd);
	const writeTool = createWriteTool(cwd);
	const findTool = createFindTool(cwd);
	const grepTool = createGrepTool(cwd);
	const lsTool = createLsTool(cwd);

	pi.registerTool({
		name: "read",
		label: "read",
		description: readTool.description,
		parameters: readTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createReadTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = arrow(theme, "Read ");
			text += theme.fg("accent", shortenPath(args.path));
			text += theme.fg(
				"muted",
				formatKvArgs([
					["offset", args.offset],
					["limit", args.limit],
				]),
			);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);
			if (!expanded) return new Text("", 0, 0);

			const content = result.content[0];
			const details = result.details as ReadToolDetails | undefined;

			if (content?.type === "image") {
				return new Text(theme.fg("success", "Image loaded"), 0, 0);
			}
			if (content?.type !== "text") {
				return new Text("", 0, 0);
			}

			let text = theme.fg("dim", `${content.text.split("\n").length} lines`);
			if (details?.truncation?.truncated) {
				text += theme.fg("warning", ` • truncated from ${details.truncation.totalLines} lines`);
			}
			text += "\n" + theme.fg("toolOutput", content.text);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: bashTool.description,
		parameters: bashTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createBashTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = arrow(theme, "Bash ");
			text += theme.fg("accent", args.command);
			text += theme.fg("muted", formatKvArgs([["timeout", args.timeout]]));
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Running..."), 0, 0);
			if (!expanded) return new Text("", 0, 0);
			const content = result.content[0];
			const details = result.details as BashToolDetails | undefined;
			const output = content?.type === "text" ? content.text : "";
			let text = theme.fg("dim", `${output.split("\n").filter((line) => line.trim().length > 0).length} output lines`);
			if (details?.truncation?.truncated) {
				text += theme.fg("warning", " • truncated");
			}
			if (output) {
				text += "\n" + theme.fg("toolOutput", output);
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description: editTool.description,
		parameters: editTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createEditTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = arrow(theme, "Edit ");
			text += theme.fg("accent", shortenPath(args.path));
			text += theme.fg("muted", formatKvArgs([["edits", args.edits?.length]]));
			return new Text(text, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Editing..."), 0, 0);
			const details = result.details as EditToolDetails | undefined;
			const content = result.content[0];
			if (content?.type === "text" && /^Error/i.test(content.text)) {
				return new Text(theme.fg("error", content.text), 0, 0);
			}
			if (!details?.diff) {
				return new Text(theme.fg("success", "Updated"), 0, 0);
			}
			return renderDiff(theme, details.diff, 40);
		},
	});

	pi.registerTool({
		name: "write",
		label: "write",
		description: writeTool.description,
		parameters: writeTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const absolutePath = resolve(ctx.cwd, params.path);
			let before = "";
			try {
				before = await readFile(absolutePath, "utf8");
			} catch {
				before = "";
			}

			const result = await createWriteTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
			const diff = await createUnifiedDiff(params.path, before, params.content);
			return {
				...result,
				details: diff ? { diff } : result.details,
			};
		},
		renderCall(args, theme) {
			let text = arrow(theme, "Write ");
			text += theme.fg("accent", shortenPath(args.path));
			text += theme.fg("muted", formatKvArgs([["lines", args.content?.split("\n").length]]));
			return new Text(text, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);
			const content = result.content[0];
			if (content?.type === "text" && /^Error/i.test(content.text)) {
				return new Text(theme.fg("error", content.text), 0, 0);
			}
			const details = result.details as { diff?: string } | undefined;
			if (details?.diff) {
				return renderDiff(theme, details.diff, 40);
			}
			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});

	pi.registerTool({
		name: "find",
		label: "find",
		description: findTool.description,
		parameters: findTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createFindTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = arrow(theme, "Find ");
			text += theme.fg("accent", args.pattern);
			text += theme.fg("muted", ` in ${shortenPath(args.path || ".")}`);
			text += theme.fg("muted", formatKvArgs([["limit", args.limit]]));
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			if (!expanded) return new Text("", 0, 0);
			const details = result.details as FindToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text.trim() : "";
			let text = theme.fg("dim", `${output ? output.split("\n").length : 0} files`);
			if (details?.truncated) text += theme.fg("warning", " • truncated");
			if (output) text += "\n" + theme.fg("toolOutput", output);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description: grepTool.description,
		parameters: grepTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createGrepTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = arrow(theme, "Grep ");
			text += theme.fg("accent", args.pattern);
			text += theme.fg("muted", ` in ${shortenPath(args.path || ".")}`);
			text += theme.fg("muted", formatKvArgs([["glob", args.glob], ["limit", args.limit]]));
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
			if (!expanded) return new Text("", 0, 0);
			const details = result.details as GrepToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text.trim() : "";
			let text = theme.fg("dim", `${output ? output.split("\n").length : 0} matches`);
			if (details?.truncated) text += theme.fg("warning", " • truncated");
			if (output) text += "\n" + theme.fg("toolOutput", output);
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "ls",
		label: "ls",
		description: lsTool.description,
		parameters: lsTool.parameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return createLsTool(ctx.cwd).execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme) {
			let text = arrow(theme, "Ls ");
			text += theme.fg("accent", shortenPath(args.path || "."));
			text += theme.fg("muted", formatKvArgs([["limit", args.limit]]));
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Listing..."), 0, 0);
			if (!expanded) return new Text("", 0, 0);
			const details = result.details as LsToolDetails | undefined;
			const content = result.content[0];
			const output = content?.type === "text" ? content.text.trim() : "";
			let text = theme.fg("dim", `${output ? output.split("\n").length : 0} entries`);
			if (details?.truncated) text += theme.fg("warning", " • truncated");
			if (output) text += "\n" + theme.fg("toolOutput", output);
			return new Text(text, 0, 0);
		},
	});
}
