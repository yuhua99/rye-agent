import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

type RegisterArg = Parameters<ExtensionAPI["registerTool"]>[0];
type RenderCall = NonNullable<RegisterArg["renderCall"]>;
type RenderResult = NonNullable<RegisterArg["renderResult"]>;
type Theme = Parameters<RenderCall>[1];

type Status = "running" | "ok" | "error";
type State = { status?: Status; err?: string };

const MAX = 80;

function truncate(s: string, n = MAX): string {
	if (s.length <= n) return s;
	return s.slice(0, Math.max(0, n - 1)) + "…";
}

function firstLine(s: string): string {
	const nl = s.indexOf("\n");
	return nl === -1 ? s : s.slice(0, nl);
}

function firstTextContent(result: any): string {
	const c = result?.content?.find?.((c: any) => c?.type === "text");
	return c?.type === "text" ? c.text : "";
}

function symbolFor(state: State, theme: Theme): string {
	if (state.status === "ok") return theme.fg("success", "✓");
	if (state.status === "error") return theme.fg("error", "✗");
	return theme.fg("dim", "·");
}

function callLine(symbol: string, body: string, state: State, theme: Theme): string {
	let line = `${symbol} ${body}`;
	if (state.status === "error" && state.err) {
		line += "  " + theme.fg("error", state.err);
	}
	return line;
}

function makeCallBody(toolName: string, args: any, theme: Theme): string {
	const dim = (s: string) => theme.fg("dim", s);
	const accent = (s: string) => theme.fg("accent", s);
	switch (toolName) {
		case "bash": {
			const cmdRaw = typeof args?.command === "string" ? args.command : "";
			const lines = cmdRaw.split("\n");
			let cmd = lines[0] ?? "";
			if (lines.length > 1) cmd += " …";
			return dim("$ ") + accent(truncate(cmd));
		}
		case "read": {
			const p = typeof args?.path === "string" ? args.path : "";
			let extra = "";
			if (typeof args?.offset === "number") extra += ` offset=${args.offset}`;
			if (typeof args?.limit === "number") extra += ` limit=${args.limit}`;
			return dim("read ") + accent(truncate(p)) + (extra ? dim(extra) : "");
		}
		case "write": {
			const p = typeof args?.path === "string" ? args.path : "";
			return dim("write ") + accent(truncate(p));
		}
		case "edit": {
			const p = typeof args?.path === "string" ? args.path : "";
			const n = Array.isArray(args?.edits) ? args.edits.length : 0;
			const extra = n > 0 ? ` (${n} edit${n === 1 ? "" : "s"})` : "";
			return dim("edit ") + accent(truncate(p)) + (extra ? dim(extra) : "");
		}
		case "grep": {
			const pat = typeof args?.pattern === "string" ? args.pattern : "";
			let extra = "";
			if (typeof args?.path === "string" && args.path) extra += ` in ${args.path}`;
			if (typeof args?.glob === "string" && args.glob) extra += ` glob=${args.glob}`;
			return dim("grep ") + accent(truncate(pat)) + (extra ? dim(truncate(extra, MAX)) : "");
		}
		case "find": {
			const pat = typeof args?.pattern === "string" ? args.pattern : "";
			const extra = typeof args?.path === "string" && args.path ? ` in ${args.path}` : "";
			return dim("find ") + accent(truncate(pat)) + (extra ? dim(extra) : "");
		}
		case "ls": {
			const p = typeof args?.path === "string" && args.path ? args.path : ".";
			return dim("ls ") + accent(truncate(p));
		}
		default:
			return accent(toolName);
	}
}

function computeStatus(
	result: any,
	opts: { expanded: boolean; isPartial: boolean },
	ctx: any,
): { status: Status; err?: string } {
	if (opts.isPartial) return { status: "running" };
	const text = firstTextContent(result);
	if (ctx?.isError) {
		const line = firstLine(text).trim();
		return { status: "error", err: truncate(line || "error", MAX) };
	}
	return { status: "ok" };
}

function makeRenderCall(toolName: string): RenderCall {
	return (args, theme, context) => {
		const state = context.state as State;
		const symbol = symbolFor(state, theme);
		const body = makeCallBody(toolName, args, theme);
		return new Text(callLine(symbol, body, state, theme), 0, 0);
	};
}

// context.state is a free-form per-tool-call scratch object shared between
// renderCall and renderResult; we store our own { status, err } shape in it.
const renderResult: RenderResult = (result, opts, _theme, context) => {
	const state = context.state as State;
	const next = computeStatus(result, opts, context);
	if (state.status !== next.status || state.err !== next.err) {
		state.status = next.status;
		state.err = next.err;
		context.invalidate?.();
	}

	return new Container();
};

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	const factories = [
		{ name: "bash", create: createBashToolDefinition },
		{ name: "read", create: createReadToolDefinition },
		{ name: "write", create: createWriteToolDefinition },
		{ name: "edit", create: createEditToolDefinition },
		{ name: "grep", create: createGrepToolDefinition },
		{ name: "find", create: createFindToolDefinition },
		{ name: "ls", create: createLsToolDefinition },
	] as const;

	for (const { name, create } of factories) {
		const original = create(cwd);
		pi.registerTool({
			...original,
			renderCall: makeRenderCall(name),
			renderResult,
		} as any);
	}
}
