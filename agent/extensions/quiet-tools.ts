import { basename } from "node:path";
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
const BATCHABLE = new Set(["read", "grep", "find", "ls"]);

type Member = {
	id: string;
	name: string;
	args: any;
	messageSeq: number;
	batchable: boolean;
	invalidate?: () => void;
	status?: Status;
	err?: string;
};

const members = new Map<string, Member>();
const order: string[] = [];
let messageSeq = 0;
let refreshing = false;

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

function symbolFor(status: Status | undefined, theme: Theme): string {
	if (status === "ok") return theme.fg("success", "✓");
	if (status === "error") return theme.fg("error", "✗");
	return theme.fg("dim", "·");
}

function callLine(symbol: string, body: string, status: Status | undefined, err: string | undefined, theme: Theme): string {
	let line = `${symbol} ${body}`;
	if (status === "error" && err) {
		line += "  " + theme.fg("error", err);
	}
	return line;
}

function primaryLabel(toolName: string, args: any): string {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return typeof args?.path === "string" ? args.path : "";
		case "ls":
			return typeof args?.path === "string" && args.path ? args.path : ".";
		case "grep":
		case "find":
			return typeof args?.pattern === "string" ? args.pattern : "";
		default:
			return toolName;
	}
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

function isTerminal(status: Status | undefined): boolean {
	return status === "ok" || status === "error";
}

function ensureMember(
	toolName: string,
	args: any,
	context: { toolCallId: string; invalidate: () => void },
	batchable: boolean,
): Member {
	const id = context.toolCallId;
	const existing = members.get(id);
	if (existing) {
		existing.args = args;
		existing.invalidate = context.invalidate;
		return existing;
	}

	const lastId = order[order.length - 1];
	const last = lastId ? members.get(lastId) : undefined;
	if (batchable && last?.batchable && last.name === toolName && isTerminal(last.status)) {
		messageSeq++;
	}

	const member: Member = {
		id,
		name: toolName,
		args,
		messageSeq,
		batchable,
		invalidate: context.invalidate,
	};
	members.set(id, member);
	order.push(id);
	return member;
}

function sameStreak(a: Member, b: Member): boolean {
	return a.batchable && b.batchable && a.name === b.name && a.messageSeq === b.messageSeq;
}

function streakOf(id: string): Member[] {
	const self = members.get(id);
	if (!self || !self.batchable) return self ? [self] : [];
	const idx = order.indexOf(id);
	if (idx < 0) return [self];

	let start = idx;
	while (start > 0) {
		const prev = members.get(order[start - 1]);
		if (!prev || !sameStreak(prev, self)) break;
		start--;
	}
	let end = idx;
	while (end + 1 < order.length) {
		const next = members.get(order[end + 1]);
		if (!next || !sameStreak(next, self)) break;
		end++;
	}
	const out: Member[] = [];
	for (let i = start; i <= end; i++) {
		const m = members.get(order[i]);
		if (m) out.push(m);
	}
	return out;
}

function streakStatus(streak: Member[]): Status | undefined {
	if (streak.some((m) => !m.status || m.status === "running")) return "running";
	if (streak.some((m) => m.status === "error")) return "error";
	if (streak.every((m) => m.status === "ok")) return "ok";
	return undefined;
}

function lastNonError(streak: Member[]): Member | undefined {
	for (let i = streak.length - 1; i >= 0; i--) {
		if (streak[i].status !== "error") return streak[i];
	}
	return undefined;
}

function summaryBody(toolName: string, streak: Member[], theme: Theme): string {
	const dim = (s: string) => theme.fg("dim", s);
	const accent = (s: string) => theme.fg("accent", s);
	const labels = streak
		.map((m) => primaryLabel(toolName, m.args))
		.filter(Boolean)
		.map((label) => (toolName === "read" || toolName === "ls" ? basename(label) : label));
	const joined = truncate(labels.join(", "), MAX);
	return dim(`${toolName} ×${streak.length} `) + accent(joined);
}

function refreshStreak(id: string): void {
	if (refreshing) return;
	refreshing = true;
	try {
		for (const m of streakOf(id)) {
			if (m.id !== id) m.invalidate?.();
		}
	} finally {
		refreshing = false;
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
		const batchable = BATCHABLE.has(toolName);
		const member = ensureMember(toolName, args, context, batchable);
		if (state.status) {
			member.status = state.status;
			member.err = state.err;
		}

		if (!batchable) {
			const symbol = symbolFor(state.status, theme);
			const body = makeCallBody(toolName, args, theme);
			return new Text(callLine(symbol, body, state.status, state.err, theme), 1, 0);
		}

		const streak = streakOf(member.id);
		const summaryHost = lastNonError(streak);
		const visible = member.status === "error" || member.id === summaryHost?.id;

		refreshStreak(member.id);

		if (!visible) return new Text("", 0, 0);

		if (member.status === "error") {
			const symbol = symbolFor("error", theme);
			const body = makeCallBody(toolName, args, theme);
			return new Text(callLine(symbol, body, "error", member.err, theme), 1, 0);
		}

		const okStreak = streak.filter((m) => m.status !== "error");
		const status = okStreak.length > 1 ? streakStatus(okStreak) : member.status;
		const symbol = symbolFor(status, theme);
		const body =
			okStreak.length > 1 ? summaryBody(toolName, okStreak, theme) : makeCallBody(toolName, args, theme);
		return new Text(callLine(symbol, body, status, undefined, theme), 1, 0);
	};
}

const renderResult: RenderResult = (result, opts, _theme, context) => {
	const state = context.state as State;
	const next = computeStatus(result, opts, context);
	const changed = state.status !== next.status || state.err !== next.err;
	if (changed) {
		state.status = next.status;
		state.err = next.err;
	}

	const member = members.get(context.toolCallId);
	if (member) {
		member.status = next.status;
		member.err = next.err;
		if (changed) refreshStreak(member.id);
	}

	if (changed) context.invalidate?.();
	return new Container();
};

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") messageSeq++;
	});

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
			renderShell: "self",
			renderCall: makeRenderCall(name),
			renderResult,
		} as any);
	}
}
