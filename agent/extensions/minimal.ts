import type {
	ExtensionAPI,
	FindToolDetails,
	GrepToolDetails,
	LsToolDetails,
	ReadToolDetails,
} from "@mariozechner/pi-coding-agent";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
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

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const readTool = createReadTool(cwd);
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
