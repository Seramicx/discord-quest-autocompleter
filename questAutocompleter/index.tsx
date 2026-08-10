/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { find, findByCodeLazy } from "@webpack";
import { ApplicationStreamingStore, ChannelStore, FluxDispatcher, GuildChannelStore, RestAPI, RunningGameStore } from "@webpack/common";

const settings = definePluginSettings({
    autoAcceptQuests: {
        type: OptionType.BOOLEAN,
        description: "Automatically accept all available quests",
        default: false,
        restartNeeded: false
    },
    fetchIntervalMinutes: {
        type: OptionType.NUMBER,
        description: "How often to ask Discord for new quests, in minutes (minimum 30)",
        default: 120,
        restartNeeded: false
    },
    logProgress: {
        type: OptionType.BOOLEAN,
        description: "Log quest completion progress to console",
        default: true,
        restartNeeded: false
    }
});

const SUPPORTED_TASKS = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "PLAY_ACTIVITY", "WATCH_VIDEO_ON_MOBILE"];

const MIN_FETCH_MINUTES = 30;
const SCAN_INTERVAL_MS = 60_000;

const fetchQuests = findByCodeLazy("QUESTS_FETCH_CURRENT_QUESTS_BEGIN") as () => Promise<unknown>;

// displayName doesn't survive minification, so match on shape instead
let questsStore: any = null;
function getQuestsStore() {
    questsStore ??= find((m: any) => m?.quests instanceof Map && typeof m.getQuest === "function", { isIndirect: true });
    return questsStore;
}

let isApp: boolean;

let processingQuests = false;
let questQueue: any[] = [];
let activeQuestId: string | null = null;
let activeCleanup: (() => void) | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let fetchInterval: ReturnType<typeof setInterval> | null = null;
let fluxUnsubs: (() => void)[] = [];

// async loops capture this and bail once it moves, otherwise they keep hitting the API after stop()
let generation = 0;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function log(...args: any[]) {
    if (settings.store.logProgress) {
        console.log("[QuestAutocompleter]", ...args);
    }
}

function getTaskConfig(quest: any) {
    return quest.config.taskConfig ?? quest.config.taskConfigV2;
}

function isCompletable(quest: any): boolean {
    if (new Date(quest.config.expiresAt).getTime() <= Date.now()) return false;
    const tasks = getTaskConfig(quest)?.tasks;
    if (!tasks) return false;
    return SUPPORTED_TASKS.some(t => tasks[t] != null);
}

function isEnrolled(quest: any): boolean {
    return !!quest.userStatus?.enrolledAt;
}

function isCompleted(quest: any): boolean {
    return !!quest.userStatus?.completedAt;
}

// queued entries go stale while a long quest runs, so re-read before use
function refreshQuest(quest: any) {
    return getQuestsStore()?.quests?.get(quest.id) ?? quest;
}

async function enrollQuest(quest: any): Promise<boolean> {
    const name = quest.config.messages.questName;
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await RestAPI.post({
                url: `/quests/${quest.id}/enroll`,
                body: {
                    location: 11,
                    is_targeted: false,
                    metadata_raw: null,
                    metadata_sealed: null,
                    traffic_metadata_raw: null
                }
            });

            if (res?.status === 429) {
                const waitMs = ((res.body?.retry_after ?? 5) + 1) * 1000;
                log(`Rate limited on "${name}" (attempt ${attempt}/${MAX_RETRIES}) – waiting ${Math.ceil(waitMs / 1000)}s...`);
                if (attempt < MAX_RETRIES) await sleep(waitMs);
                continue;
            }

            log(`Auto-accepted: ${name}`);
            return true;

        } catch (e: any) {
            const status: number = e?.status ?? e?.res?.status ?? 0;
            const body: any      = e?.body   ?? e?.res?.body   ?? {};

            if (status === 429) {
                const waitMs = ((body?.retry_after ?? 5) + 1) * 1000;
                log(`Rate limited on "${name}" (attempt ${attempt}/${MAX_RETRIES}) – waiting ${Math.ceil(waitMs / 1000)}s...`);
                if (attempt < MAX_RETRIES) await sleep(waitMs);
                continue;
            }

            log(`Failed to accept "${name}" (status ${status}):`, body?.message ?? e);
            return false;
        }
    }

    log(`Gave up enrolling "${name}" after ${MAX_RETRIES} rate-limited attempts`);
    return false;
}

async function autoAcceptAvailableQuests(): Promise<boolean> {
    if (!settings.store.autoAcceptQuests) return false;
    const store = getQuestsStore();
    if (!store?.quests) return false;

    const unaccepted = [...store.quests.values()].filter((q: any) =>
        !isEnrolled(q) && !isCompleted(q) && isCompletable(q)
    );

    if (unaccepted.length === 0) return false;

    log(`Auto-accepting ${unaccepted.length} quest(s)...`);
    let enrolledAny = false;

    for (const q of unaccepted) {
        const ok = await enrollQuest(q);
        if (ok) enrolledAny = true;
        await sleep(3000);
    }

    return enrolledAny;
}

function syncQueueFromStore() {
    const store = getQuestsStore();
    if (!store?.quests) return;

    const enrolled = [...store.quests.values()].filter((q: any) =>
        isEnrolled(q) && !isCompleted(q) && isCompletable(q)
    );

    let added = 0;
    for (const quest of enrolled) {
        if (quest.id === activeQuestId) continue;
        if (!questQueue.find(q => q.id === quest.id)) {
            questQueue.push(quest);
            added++;
            log(`Queued: ${quest.config.messages.questName}`);
        }
    }

    if (added > 0) log(`${added} quest(s) added to queue (total: ${questQueue.length})`);

    if (!processingQuests && questQueue.length > 0) {
        log("Starting processing loop...");
        doJob();
    }
}

async function scan() {
    const newlyEnrolled = await autoAcceptAvailableQuests();
    if (newlyEnrolled) await sleep(1500);
    syncQueueFromStore();
}

async function fetchNewQuests() {
    try {
        log("Checking for new quests...");
        await fetchQuests();
        await sleep(1000);
    } catch (e) {
        log("Quest fetch failed (will retry next cycle):", e);
        return;
    }
    await scan();
}

function shutdown() {
    generation++;

    activeCleanup?.();
    activeCleanup = null;
    activeQuestId = null;
    processingQuests = false;
    questQueue = [];

    if (pollInterval !== null) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    if (fetchInterval !== null) {
        clearInterval(fetchInterval);
        fetchInterval = null;
    }
}

function startSession() {
    shutdown();

    isApp = typeof (window as any).DiscordNative !== "undefined";

    const minutes = Math.max(MIN_FETCH_MINUTES, settings.store.fetchIntervalMinutes ?? 120);
    pollInterval = setInterval(() => scan(), SCAN_INTERVAL_MS);
    fetchInterval = setInterval(() => fetchNewQuests(), minutes * 60_000);
    log(`Session started (isApp = ${isApp}, checking for new quests every ${minutes} min)`);

    fetchNewQuests();
}

function doJob() {
    activeCleanup?.();
    activeCleanup = null;
    activeQuestId = null;

    const queued = questQueue.shift();
    if (!queued) {
        processingQuests = false;
        log("All queued quests done.");
        return;
    }

    const quest = refreshQuest(queued);
    if (isCompleted(quest)) {
        doJob();
        return;
    }

    processingQuests = true;
    activeQuestId = quest.id;

    try {
        startQuest(quest);
    } catch (e) {
        log(`Failed to start "${quest.config.messages?.questName}":`, e);
        doJob();
    }
}

function startQuest(quest: any) {
    const myGen           = generation;
    const pid             = Math.floor(Math.random() * 30000) + 1000;
    const questName       = quest.config.messages.questName;
    const taskConfig      = getTaskConfig(quest);
    const taskName        = SUPPORTED_TASKS.find(x => taskConfig.tasks[x] != null)!;
    const taskData        = taskConfig.tasks[taskName];
    const applicationId   = quest.config.application?.id ?? taskData.applications?.[0]?.id;
    const applicationName = quest.config.application?.name ?? taskData.applications?.[0]?.name ?? questName;
    const secondsNeeded   = taskData.target;
    let secondsDone       = quest.userStatus?.progress?.[taskName]?.value ?? 0;

    if (taskName === "WATCH_VIDEO" || taskName === "WATCH_VIDEO_ON_MOBILE") {
        const maxFuture = 10, speed = 7, interval = 1;
        const enrolledAt = new Date(quest.userStatus.enrolledAt).getTime();
        let completed = false;

        (async () => {
            try {
                while (myGen === generation) {
                    const maxAllowed = Math.floor((Date.now() - enrolledAt) / 1000) + maxFuture;
                    const diff = maxAllowed - secondsDone;
                    const timestamp = secondsDone + speed;

                    if (diff >= speed) {
                        const res = await RestAPI.post({
                            url: `/quests/${quest.id}/video-progress`,
                            body: { timestamp: Math.min(secondsNeeded, timestamp + Math.random()) }
                        });
                        completed = res.body?.completed_at != null;
                        secondsDone = Math.min(secondsNeeded, timestamp);
                    }

                    if (timestamp >= secondsNeeded) break;
                    await sleep(interval * 1000);
                }

                if (myGen !== generation) return;

                if (!completed) {
                    await RestAPI.post({
                        url: `/quests/${quest.id}/video-progress`,
                        body: { timestamp: secondsNeeded }
                    });
                }

                log(`Completed: ${questName}`);
            } catch (e) {
                log(`Error completing "${questName}":`, e);
            }
            if (myGen === generation) doJob();
        })();

        log(`Spoofing video: ${questName}`);

    } else if (taskName === "PLAY_ON_DESKTOP") {
        if (!isApp) {
            log(`${questName} requires the desktop app – skipping`);
            doJob();
            return;
        }

        RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` })
            .then((res: any) => {
                if (myGen !== generation) return;

                const appData = res.body?.[0];

                if (!appData) {
                    log(`No app data returned for "${questName}" – skipping`);
                    doJob();
                    return;
                }

                const win32Exe = appData.executables?.find((x: any) => x.os === "win32");
                const anyExe   = appData.executables?.[0];
                const exeName  = (win32Exe ?? anyExe)?.name?.replace(">", "") ?? `${appData.name}.exe`;

                const fakeGame: any = {
                    cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                    exeName,
                    exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                    hidden: false,
                    isLauncher: false,
                    id: applicationId,
                    name: appData.name,
                    pid,
                    pidPath: [pid],
                    processName: appData.name,
                    start: Date.now(),
                };

                const realGames           = RunningGameStore.getRunningGames();
                const realGetRunningGames = RunningGameStore.getRunningGames;
                const realGetGameForPID   = RunningGameStore.getGameForPID;

                let done = false;
                const cleanup = () => {
                    if (done) return;
                    done = true;
                    RunningGameStore.getRunningGames = realGetRunningGames;
                    RunningGameStore.getGameForPID   = realGetGameForPID;
                    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: [], games: [] });
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                };

                RunningGameStore.getRunningGames = () => [fakeGame];
                RunningGameStore.getGameForPID   = (p: number) => (p === fakeGame.pid ? fakeGame : null);
                FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: [fakeGame] });

                const fn = (data: any) => {
                    if (data.questId !== quest.id) return;

                    try {
                        const progress = quest.config.configVersion === 1
                            ? data.userStatus.streamProgressSeconds
                            : Math.floor(data.userStatus.progress.PLAY_ON_DESKTOP.value);

                        log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                        if (progress >= secondsNeeded) {
                            log(`Completed: ${questName}`);
                            doJob();
                        }
                    } catch (e) {
                        log(`Error in heartbeat handler for "${questName}":`, e);
                        doJob();
                    }
                };

                FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
                activeCleanup = cleanup;
                log(`Spoofed game: ${applicationName} – ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min left`);
            })
            .catch((e: any) => {
                if (myGen !== generation) return;
                log(`Failed to fetch app data for "${questName}":`, e);
                doJob();
            });

    } else if (taskName === "STREAM_ON_DESKTOP") {
        if (!isApp) {
            log(`${questName} requires the desktop app – skipping`);
            doJob();
            return;
        }

        const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;

        let done = false;
        const cleanup = () => {
            if (done) return;
            done = true;
            ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
            FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        };

        ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
            id: applicationId,
            pid,
            sourceName: null
        });

        const fn = (data: any) => {
            if (data.questId !== quest.id) return;

            try {
                const progress = quest.config.configVersion === 1
                    ? data.userStatus.streamProgressSeconds
                    : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);

                log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                if (progress >= secondsNeeded) {
                    log(`Completed: ${questName}`);
                    doJob();
                }
            } catch (e) {
                log(`Error in heartbeat handler for "${questName}":`, e);
                doJob();
            }
        };

        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", fn);
        activeCleanup = cleanup;
        log(`Spoofed stream: ${applicationName} – ~${Math.ceil((secondsNeeded - secondsDone) / 60)} min left (need 1+ in VC)`);

    } else if (taskName === "PLAY_ACTIVITY") {
        const channelId =
            ChannelStore.getSortedPrivateChannels()[0]?.id ??
            (Object.values(GuildChannelStore.getAllGuilds()) as any[])
                .find((x: any) => x?.VOCAL?.length > 0)?.VOCAL[0]?.channel?.id;

        if (!channelId) {
            log("No suitable channel found for PLAY_ACTIVITY – skipping");
            doJob();
            return;
        }

        const streamKey = `call:${channelId}:1`;

        (async () => {
            try {
                log(`Activity: ${questName}`);
                while (myGen === generation) {
                    const res = await RestAPI.post({
                        url: `/quests/${quest.id}/heartbeat`,
                        body: { stream_key: streamKey, terminal: false }
                    });
                    const progress = res.body.progress.PLAY_ACTIVITY.value;
                    log(`[${questName}] Progress: ${progress}/${secondsNeeded}`);

                    if (progress >= secondsNeeded) {
                        await RestAPI.post({
                            url: `/quests/${quest.id}/heartbeat`,
                            body: { stream_key: streamKey, terminal: true }
                        });
                        break;
                    }

                    await sleep(20000);
                }
                if (myGen !== generation) return;
                log(`Completed: ${questName}`);
            } catch (e) {
                log(`Error completing "${questName}":`, e);
            }
            if (myGen === generation) doJob();
        })();
    }
}

export default definePlugin({
    name: "QuestAutocompleter",
    description: "Automatically completes Discord quests. Supports auto-accept and spoofing game/stream/video progress.",
    authors: [{ name: "Seramicx", id: 543577333530099742n }],
    settings,

    start() {
        log("Starting...");

        const onConnectionOpen = () => {
            log("CONNECTION_OPEN – starting new session...");
            startSession();
        };

        const onStatusUpdate = () => {
            setTimeout(() => syncQueueFromStore(), 500);
        };

        FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
        FluxDispatcher.subscribe("QUEST_USER_STATUS_UPDATE", onStatusUpdate);

        fluxUnsubs = [
            () => FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen),
            () => FluxDispatcher.unsubscribe("QUEST_USER_STATUS_UPDATE", onStatusUpdate),
        ];

        startSession();
    },

    stop() {
        log("Stopping...");

        for (const unsub of fluxUnsubs) unsub();
        fluxUnsubs = [];

        shutdown();
    }
});