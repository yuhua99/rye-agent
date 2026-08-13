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
import { Type } from "typebox";

type RegisterArg = Parameters<ExtensionAPI["registerTool"]>[0];
type RenderCall = NonNullable<RegisterArg["renderCall"]>;
type RenderResult = NonNullable<RegisterArg["renderResult"]>;
type Theme = Parameters<RenderCall>[1];
type State = { status?: "running" | "ok" | "error"; err?: string };

function truncate(s: string): string {
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

function firstTextContent(result: any): string {
  const content = result?.content?.find?.((item: any) => item?.type === "text");
  return content?.type === "text" ? content.text : "";
}

function symbol(status: State["status"], theme: Theme): string {
  if (status === "ok") return theme.fg("success", "✓");
  if (status === "error") return theme.fg("error", "✗");
  return theme.fg("dim", "·");
}

function detail(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const cmd =
        typeof args.command === "string" ? args.command.split("\n", 1)[0] : "";
      return cmd ? `$ ${truncate(cmd)}` : "";
    }
    case "read":
    case "write":
    case "edit":
      return typeof args.path === "string" ? truncate(args.path) : "";
    case "grep":
    case "find":
      return typeof args.pattern === "string" ? truncate(args.pattern) : "";
    case "ls":
      return truncate(
        typeof args.path === "string" && args.path ? args.path : ".",
      );
    default:
      return "";
  }
}

function makeRenderCall(toolName: string): RenderCall {
  return (args, theme, context) => {
    const state = context.state as State;
    const callArgs = args as Record<string, unknown>;
    const d = detail(toolName, callArgs);
    const intent = typeof callArgs.intent === "string" ? callArgs.intent : "";
    let line = `${symbol(state.status, theme)} ${theme.fg("accent", intent)} ${theme.fg("dim", toolName)}`;
    if (d) line += ` ${theme.fg("dim", d)}`;
    if (state.status === "error" && state.err) {
      line += `\n  ${theme.fg("error", state.err)}`;
    }
    return new Text(line, 1, 0);
  };
}

const renderResult: RenderResult = (result, opts, _theme, context) => {
  const state = context.state as State;
  const next: State = opts.isPartial
    ? { status: "running" }
    : context.isError
      ? {
          status: "error",
          err: truncate(
            firstTextContent(result).split("\n", 1)[0].trim() || "error",
          ),
        }
      : { status: "ok" };
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
    const def = create(cwd);
    pi.registerTool({
      ...def,
      parameters: Type.Object({
        ...(def.parameters as { properties?: Record<string, unknown> })
          .properties,
        intent: Type.String({
          description:
            "Required short UI label for why this call is being made. Match the user's language.",
        }),
      }),
      prepareArguments: def.prepareArguments
        ? (args) => ({
            ...(def.prepareArguments!(args) as Record<string, unknown>),
            intent: (args as Record<string, unknown> | null)?.intent,
          })
        : undefined,
      execute: (id, params, signal, onUpdate, ctx) => {
        const { intent: _, ...rest } = params as Record<string, unknown>;
        return def.execute(id, rest as any, signal, onUpdate, ctx);
      },
      renderShell: "self",
      renderCall: makeRenderCall(name),
      renderResult,
    } as any);
  }
}
