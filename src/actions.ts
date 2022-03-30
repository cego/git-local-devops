import { getProjectDirFromRemote } from "./project";
import chalk from "chalk";
import { default as to } from "await-to-js";
import { Config } from "./types/config";
import * as pcp from "promisify-child-process";
import { GroupKey, ToChildProcessOutput } from "./types/utils";
import { getPriorityRange } from "./priority";

export async function runActions(
	config: Config,
	cwd: string,
	actionToRun: string,
	groupToRun: string,
	runActionFn: (
		opts: RunActionOpts,
	) => Promise<(GroupKey & pcp.Output) | undefined> = runAction,
): Promise<(GroupKey & pcp.Output)[]> {
	const prioRange = getPriorityRange(Object.values(config.projects));

	const stdoutBuffer: (GroupKey & pcp.Output)[] = [];
	for (
		let currentPrio = prioRange.min;
		currentPrio <= prioRange.max;
		currentPrio++
	) {
		const runActionPromises = Object.keys(config.projects).map((project) =>
			runActionFn({
				cwd,
				config,
				keys: { project: project, action: actionToRun, group: groupToRun },
				currentPrio,
			}),
		);
		(await Promise.all(runActionPromises))
			.filter((p) => p)
			.forEach((p) => stdoutBuffer.push(p as GroupKey & { stdout: string }));
	}
	return stdoutBuffer;
}

interface RunActionOpts {
	cwd: string;
	config: Config;
	keys: GroupKey;
	currentPrio: number;
}

export async function runAction(
	options: RunActionOpts,
): Promise<(GroupKey & pcp.Output) | undefined> {
	if (!(options.keys.project in options.config.projects)) return;
	const project = options.config.projects[options.keys.project];

	const dir = getProjectDirFromRemote(options.cwd, project.remote);

	if (!(options.keys.action in project.actions)) return;
	const action = project.actions[options.keys.action];

	if (!(options.keys.group in action.groups)) return;
	const group = action.groups[options.keys.group];

	const priority = action.priority ?? project.priority ?? 0;

	if (options.currentPrio !== priority) return;

	console.log(chalk`{blue ${group.join(" ")}} is running in {cyan ${dir}}`);
	const [err, res]: ToChildProcessOutput = await to(
		pcp.spawn(group[0], group.slice(1), {
			cwd: dir,
			env: process.env,
			encoding: "utf8",
		}),
	);

	if (err) {
		console.error(
			chalk`"${options.keys.action}" "${options.keys.group}" {red failed}, ` +
				chalk`goto {cyan ${dir}} and run {blue ${group.join(" ")}} manually`,
		);
	}

	return {
		...options.keys,
		stdout: res?.stdout?.toString() ?? "",
		stderr: res?.stderr?.toString() ?? "",
	};
}
