import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { anthropic } from "./anthropic.js";
import { codex } from "./codex.js";
import type { UsageSnapshot } from "./types.js";
import { xai } from "./xai.js";

const PROVIDERS = [anthropic, codex, xai];
const ENTRY_TYPE = "usage";
const BAR_WIDTH = 20;
const PARTIALS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"];

function formatPercent(value: number): string {
	return `${Math.round(value)}%`.padStart(4);
}

function fgToBgAnsi(fgAnsi: string): string {
	return fgAnsi.replace("\x1b[38;", "\x1b[48;");
}

function renderContinuousBar(percent: number, theme?: Theme): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filledFloat = (clamped / 100) * BAR_WIDTH;
	const filledFull = Math.floor(filledFloat);
	const remainder = filledFloat - filledFull;
	let filled = "█".repeat(filledFull);
	let emptyCount = BAR_WIDTH - filledFull;
	if (remainder >= 0.0625 && filledFull < BAR_WIDTH) {
		const levelIndex = Math.max(0, Math.min(PARTIALS.length - 1, Math.round(remainder * 8) - 1));
		filled += PARTIALS[levelIndex];
		emptyCount -= 1;
	}
	const empty = " ".repeat(Math.max(0, emptyCount));
	if (!theme) return filled + empty;
	const trackBg = fgToBgAnsi(theme.getFgAnsi("dim"));
	const fillFg = theme.getFgAnsi("muted");
	const cardBg = theme.getBgAnsi("customMessageBg");
	return `${trackBg}${fillFg}${filled}${empty}\x1b[39m${cardBg}`;
}

function formatWindow(window: UsageSnapshot["windows"][number], theme?: Theme): string {
	const reset = window.resetDescription ? `  resets ${window.resetDescription}` : "";
	const label = window.label.padEnd(8);
	const bar = renderContinuousBar(window.usedPercent, theme);
	const suffix = formatPercent(window.usedPercent);
	if (!theme) return `  ${label} ${bar} ${suffix}${reset}`;
	const resetText = window.resetDescription ? theme.fg("dim", `  resets ${window.resetDescription}`) : "";
	return `  ${theme.fg("muted", label)} ${bar} ${theme.fg("muted", suffix)}${resetText}`;
}

function formatSnapshot(usage: UsageSnapshot, theme?: Theme): string {
	const lines = [theme ? theme.bold(usage.displayName) : usage.displayName];
	if (usage.error) {
		lines.push(theme ? theme.fg("error", `  ${usage.error}`) : `  ${usage.error}`);
		return lines.join("\n");
	}
	if (usage.windows.length === 0) {
		lines.push(theme ? theme.fg("dim", "  no windows") : "  no windows");
		return lines.join("\n");
	}
	for (const window of usage.windows) lines.push(formatWindow(window, theme));
	return lines.join("\n");
}

class UsageGrid {
	constructor(private cards: string[]) {}

	render(width: number): string[] {
		if (width <= 0) return [];

		const rows: { lines: string[]; width: number }[][] = [];
		let row: { lines: string[]; width: number }[] = [];
		let rowWidth = 0;
		for (const card of this.cards) {
			let lines = card.split("\n");
			let cardWidth = Math.max(...lines.map(visibleWidth));
			if (cardWidth > width) {
				lines = wrapTextWithAnsi(card, width);
				cardWidth = Math.max(...lines.map(visibleWidth));
			}

			if (row.length > 0 && rowWidth + 2 + cardWidth > width) {
				rows.push(row);
				row = [];
				rowWidth = 0;
			}
			row.push({ lines, width: cardWidth });
			rowWidth += (rowWidth > 0 ? 2 : 0) + cardWidth;
		}
		if (row.length > 0) rows.push(row);

		return rows.flatMap((cards, rowIndex) => [
			...(rowIndex > 0 ? [""] : []),
			...Array.from({ length: Math.max(...cards.map((card) => card.lines.length)) }, (_, lineIndex) =>
				cards
					.map((card) => {
						const line = card.lines[lineIndex] ?? "";
						return line + " ".repeat(card.width - visibleWidth(line));
					})
					.join("  "),
			),
		]);
	}

	invalidate() {}
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<UsageSnapshot[]>("usage", (entry, _opts, theme) => {
		const snapshots = entry.data ?? [];
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (snapshots.length === 0) {
			box.addChild(new Text(theme.fg("dim", "No logged-in providers"), 0, 0));
			return box;
		}
		const blocks = snapshots.map((snapshot) => formatSnapshot(snapshot, theme));
		box.addChild(new UsageGrid(blocks));
		return box;
	});

	pi.registerCommand("usage", {
		description: "Show subscription usage for logged-in providers",
		handler: async (_args, ctx) => {
			const loggedIn = PROVIDERS.filter((provider) => provider.hasCredentials());
			if (loggedIn.length === 0) {
				ctx.ui.notify("No logged-in providers", "warning");
				return;
			}

			const names = loggedIn.map((provider) => provider.displayName).join(", ");
			ctx.ui.setWidget("usage", (_tui, theme) => ({
				render: () => [theme.fg("dim", `Fetching usage: ${names}`)],
				invalidate: () => {},
			}));
			try {
				const snapshots = await Promise.all(
					loggedIn.map(async (provider) => {
						try {
							return (await provider.fetchUsage()).usage;
						} catch (error) {
							return {
								provider: provider.name,
								displayName: provider.displayName,
								windows: [],
								error: error instanceof Error ? error.message : String(error),
							} satisfies UsageSnapshot;
						}
					}),
				);
				pi.appendEntry<UsageSnapshot[]>(ENTRY_TYPE, snapshots);

				if (ctx.mode !== "tui") {
					ctx.ui.notify(snapshots.map((snapshot) => formatSnapshot(snapshot)).join("\n\n"), "info");
				}
			} finally {
				ctx.ui.setWidget("usage", undefined);
			}
		},
	});
}
