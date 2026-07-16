import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const QUEUE = "@pi_ready_panes";
const COUNT = "@pi_ready_count";

function tmux(args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("tmux", args, { encoding: "utf8" }, (err, stdout) => {
			if (err) {
				resolve(null);
				return;
			}
			resolve(stdout.trimEnd());
		});
	});
}

async function readQueue(): Promise<string[]> {
	const value = await tmux(["show", "-gv", QUEUE]);
	if (!value) return [];
	return value.split(/\s+/).filter(Boolean);
}

async function writeQueue(panes: string[]): Promise<void> {
	if (panes.length === 0) {
		await tmux(["set", "-gu", QUEUE]);
		await tmux(["set", "-gu", COUNT]);
	} else {
		await tmux(["set", "-g", QUEUE, panes.join(" ")]);
		await tmux(["set", "-g", COUNT, String(panes.length)]);
	}
	await tmux(["refresh-client", "-S"]);
}

async function enqueue(pane: string): Promise<void> {
	const panes = await readQueue();
	if (!panes.includes(pane)) panes.push(pane);
	await writeQueue(panes);
}

async function dequeue(pane: string): Promise<void> {
	await writeQueue((await readQueue()).filter((p) => p !== pane));
}

export default function (pi: ExtensionAPI) {
	// pi-subagent children set PI_SUBAGENT=1; only the interactive main agent should notify.
	if (process.env.PI_SUBAGENT === "1") return;

	pi.on("agent_start", async () => {
		const pane = process.env.TMUX_PANE;
		if (!pane) return;
		await dequeue(pane);
	});

	pi.on("agent_settled", async () => {
		const pane = process.env.TMUX_PANE;
		if (!pane) return;

		const info = await tmux([
			"display",
			"-p",
			"-t",
			pane,
			"#{session_attached}\t#{window_active}\t#{pane_active}",
		]);
		if (info === null) return;

		const [attached, windowActive, paneActive] = info.split("\t");
		if (attached !== "0" && windowActive === "1" && paneActive === "1") return;

		await enqueue(pane);
	});
}
