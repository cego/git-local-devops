import { getProjectDirFromRemote } from "./project";
import { Config, ProjectAction } from "./types/config";
import { ChildProcessOutput, GroupKey } from "./types/utils";
import { topologicalSortActionGraph } from "./graph";
import * as utils from "./utils";
import { ExecaError, ExecaReturnValue } from "execa";
import { ActionOutputPrinter } from "./actions_utils";
import _ from "lodash";

export type ActionOutput = GroupKey &
	ChildProcessOutput & { dir?: string; cmd?: string[]; wasSkippedBy?: string; wasSkippedDuplicated?: boolean };

export async function actions(
	config: Config,
	actionToRun: string,
	groupToRun: string,
	projectsToRun: string[],
	actionOutputPrinter: ActionOutputPrinter,
	runActionFn: (opts: RunActionOpts) => Promise<ActionOutput> = runAction,
): Promise<ActionOutput[]> {
	const projectsToRunActionIn = getProjectsToRunActionIn(config, actionToRun, groupToRun, projectsToRun);
	const uniquePriorities = getUniquePriorities(projectsToRunActionIn);
	const blockedProjects = projectsToRunActionIn.filter((action) => (action.needs?.length ?? 0) > 0);
	const waitingOn = [] as string[];

	actionOutputPrinter.init(projectsToRunActionIn);

	// Go through the sorted priority groups, and run the actions
	// After an action is run, the runActionPromiseWrapper will handle calling any actions that needs the completed action.
	const stdoutBuffer: ActionOutput[] = [];
	for (const priority of uniquePriorities) {
		const runActionPromises = projectsToRunActionIn
			.filter((action) => (action.priority ?? 0) === priority && (action.needs?.length ?? 0) === 0)
			.map((action) => {
				return runActionPromiseWrapper(
					{
						config,
						keys: { project: action.project, action: action.action, group: action.group },
						actionOutputPrinter,
					},
					runActionFn,
					actionOutputPrinter,
					blockedProjects,
					waitingOn,
				);
			});

		(await Promise.all(runActionPromises)).forEach((outputArr) =>
			outputArr.forEach((output) => stdoutBuffer.push(output)),
		);
	}

	return stdoutBuffer;
}
export function getUniquePriorities(actionsToRun: (GroupKey & ProjectAction)[]): Set<number> {
	return actionsToRun.reduce((carry, action) => {
		carry.add(action.priority ?? 0);
		return carry;
	}, new Set<number>());
}

export async function runActionPromiseWrapper(
	runActionOpts: RunActionOpts,
	runActionFn: (opts: RunActionOpts) => Promise<ActionOutput>,
	actionOutputPrinter: ActionOutputPrinter,
	blockedActions: (GroupKey & ProjectAction)[],
	waitingOn: string[],
): Promise<ActionOutput[]> {
	if (!actionOutputPrinter.beganTask(runActionOpts.keys)) {
		return [{ wasSkippedDuplicated: true, ...runActionOpts.keys }];
	}

	return runActionFn(runActionOpts).then(async (res) => {
		actionOutputPrinter.finishedTask(runActionOpts.keys.project);

		// if exit code was not zero, remove all blocked actions that needs this action
		const removedBlockedActions = res.exitCode === 0 ? [] : findActionsToSkipAfterFailure(res.project, blockedActions);

		const actionsFreedtoRun = blockedActions.reduce((carry, action, i) => {
			action.needs = action.needs?.filter((need) => need !== runActionOpts.keys.project);
			if (action.needs?.length === 0) {
				delete blockedActions[i];
				carry.push(action);
			}
			return carry;
		}, [] as (GroupKey & ProjectAction)[]);

		const runBlockedActionPromises = actionsFreedtoRun.map((action) => {
			return runActionPromiseWrapper(
				{ ...runActionOpts, keys: { ...runActionOpts.keys, project: action.project } },
				runActionFn,
				actionOutputPrinter,
				blockedActions,
				waitingOn,
			);
		});

		const blockedActionsResult = (await Promise.all(runBlockedActionPromises)).reduce((carry, blockedActionResult) => {
			return [...carry, ...blockedActionResult];
		}, [] as ActionOutput[]);
		return [res, ...blockedActionsResult, ...removedBlockedActions];
	});
}

interface RunActionOpts {
	config: Config;
	keys: GroupKey;
	actionOutputPrinter: ActionOutputPrinter;
}

export async function runAction(options: RunActionOpts): Promise<ActionOutput> {
	const project = options.config.projects[options.keys.project];
	const action = project.actions[options.keys.action];
	const group = action.groups[options.keys.group] ?? action.groups["*"];
	const dir = getProjectDirFromRemote(options.config.cwd, project.remote);

	const promise = utils.spawn(group[0], group.slice(1), {
		cwd: dir,
		env: process.env,
		encoding: "utf8",
		// increase max buffer from 200KB to 2MB
		maxBuffer: 1024 * 2048,
	});

	promise.stdout?.pipe(options.actionOutputPrinter.getWritableStream(options.keys.project));
	promise.stderr?.pipe(options.actionOutputPrinter.getWritableStream(options.keys.project));

	const res: ExecaReturnValue<string> | ExecaError<string> = await promise.catch((err) => err);

	return {
		...options.keys,
		stdout: res.stdout?.toString() ?? "",
		stderr: res.stderr?.toString() ?? "",
		exitCode: res.exitCode,
		signal: res.signal,
		dir,
		cmd: group,
	};
}

export function getProjectsToRunActionIn(
	config: Config,
	actionToRun: string,
	groupToRun: string,
	projectsToRun: string[],
): (GroupKey & ProjectAction)[] {
	// get all actions from all projects with actionToRun key

	let actionsToRun = Object.entries(config.projects)
		.filter(
			([, project]) => project.actions[actionToRun]?.groups[groupToRun] || project.actions[actionToRun]?.groups["*"],
		)
		.filter(([projectName]) => {
			return projectsToRun.includes(projectName);
		})
		.reduce((carry, [projectName, project]) => {
			carry.push({
				project: projectName,
				action: actionToRun,
				group: project.actions[actionToRun]?.groups[groupToRun] ? groupToRun : "*",
				...project.actions[actionToRun],
			});

			return carry;
		}, [] as (GroupKey & ProjectAction)[]);

	/* Resolve dependencies
	 * If we want to run project A, but A needs B, we need to run B as well.
	 */
	actionsToRun = resolveDependenciesForActions(actionsToRun, config, groupToRun, actionToRun);

	/**
	 * Sometime an action will not have the specific group it needs to run.
	 * If another action needs such action, we have to rearrange dependencies, as such action cannot be run without the specific group.
	 * This is done by adding the needs from the action without the specific group, to the actions that need the action witohut the specific group
	 *
	 * For example:
	 *
	 * A needs B, B needs C
	 *
	 * We want to run group X, but only A and C have group X.
	 * In this case we rewrite A to needs C.
	 *
	 * In order to avoid having multiple iterations, we sort the actions topologically first to ensure the dependencies are always resolved.
	 */
	topologicalSortActionGraph(config, actionToRun)
		.reverse()
		.filter((action) => !config.projects[action].actions[actionToRun]?.groups[groupToRun])
		.forEach((actionNoGroup) => {
			// Find all actions that needs this action, remove this action from the needs list, and replace it with the needs of this action
			actionsToRun
				.filter((action) => action.needs.includes(actionNoGroup))
				.forEach((action) => {
					action.needs = action.needs.filter((need) => need !== actionNoGroup);
					action.needs = [
						...(action.needs ?? []),
						...(config.projects[actionNoGroup]?.actions[actionToRun]?.needs ?? []),
					];
				});
		});

	return actionsToRun;
}
export function findActionsToSkipAfterFailure(
	failedProject: string,
	blockedActions: (GroupKey & ProjectAction)[],
): ActionOutput[] {
	const blockedActionsSkipped = [] as ActionOutput[];
	const actionsToSkip = blockedActions.filter((actionToSkip) => actionToSkip.needs?.includes(failedProject));
	actionsToSkip.forEach((actionToSkip) => {
		blockedActionsSkipped.push({
			...actionToSkip,
			wasSkippedBy: failedProject,
		});
		delete blockedActions[blockedActions.indexOf(actionToSkip)];
		findActionsToSkipAfterFailure(actionToSkip.project, blockedActions).forEach((skippedActionResult) => {
			blockedActionsSkipped.push(skippedActionResult);
		});
	});
	return blockedActionsSkipped;
}

export function resolveDependenciesForActions(
	actionsToRun: (GroupKey & ProjectAction)[],
	config: Config,
	groupToRun: string,
	actionToRun: string,
) {
	actionsToRun = [
		...actionsToRun.reduce((carry, action) => {
			return new Set([...carry, ...resolveProjectDependencies(config, action)]);
		}, new Set<GroupKey & ProjectAction>()),
	]
		.filter((action) => action.groups[groupToRun] ?? action.groups["*"])
		.map((action) => {
			return {
				...action,
				group: config.projects[action.project].actions[actionToRun]?.groups[groupToRun] ? groupToRun : "*",
			};
		});

	return _.uniqBy(actionsToRun, (action) => action.project);
}

/*
 * Resolve dependencies for a key combination
 */
export function resolveProjectDependencies(
	config: Config,
	action: GroupKey & ProjectAction,
): Set<GroupKey & ProjectAction> {
	if (action.needs && action.needs.length > 0) {
		return action.needs.reduce((carry, need) => {
			const neededAction = config.projects[need].actions[action.action];
			return new Set([
				action,
				...resolveProjectDependencies(config, {
					...action,
					project: need,
					...neededAction,
				}),
				...carry,
			]);
		}, new Set<GroupKey & ProjectAction>());
	}
	return new Set<GroupKey & ProjectAction>([action]);
}
