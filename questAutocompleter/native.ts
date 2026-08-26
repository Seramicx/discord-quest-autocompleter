/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// renderer fetches are blocked here by CSP + missing CORS headers, so these run in the main process

interface AuthorizeArgs {
    appId: string;
    questId: string;
    referrer: string;
    code: string;
}

interface ProgressArgs {
    appId: string;
    questId: string;
    referrer: string;
    token: string;
    progress: number;
}

// capsolver and 2captcha share the same v2 createTask/getTaskResult protocol
const SOLVER_HOSTS = {
    capsolver: "api.capsolver.com",
    twocaptcha: "api.2captcha.com"
} as const;

// nopecha uses its own token endpoint: POST submits the job, GET polls for the token
async function solveNopecha(apiKey: string, websiteUrl: string, siteKey: string) {
    const res = await fetch("https://api.nopecha.com/token/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKey, type: "hcaptcha", sitekey: siteKey, url: websiteUrl })
    });
    const created = await res.json();
    if (created.error) throw new Error(`nopecha submit failed: ${created.message ?? created.error}`);

    for (let waited = 0; waited < 120_000; waited += 5000) {
        await new Promise(r => setTimeout(r, 5000));
        const pollRes = await fetch(`https://api.nopecha.com/token/?key=${encodeURIComponent(apiKey)}&id=${encodeURIComponent(created.data)}`);
        const result = await pollRes.json();
        if (result.error === 14) continue;
        if (result.error) throw new Error(`nopecha poll failed: ${result.message ?? result.error}`);
        return { token: result.data };
    }
    throw new Error("captcha solve timed out");
}

interface ClaimArgs {
    userToken: string;
    questId: string;
    captchaToken?: string;
    trafficMetadataSealed?: string | null;
}

// sent from the main process on purpose: going through Discord's RestAPI makes their
// client pop the native hCaptcha modal on 403 before our solver ever sees the sitekey
export async function claimReward(_, { userToken, questId, captchaToken, trafficMetadataSealed }: ClaimArgs) {
    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: userToken
    };
    if (captchaToken) headers["X-Captcha-Key"] = captchaToken;

    return post(
        `https://discord.com/api/v9/quests/${questId}/claim-reward`,
        headers,
        JSON.stringify({
            platform: 0,
            location: 11,
            is_targeted: false,
            metadata_sealed: null,
            traffic_metadata_sealed: trafficMetadataSealed ?? null
        })
    );
}

function checkArgs(appId: string, referrer: string) {
    if (!/^\d+$/.test(appId)) throw new Error("bad application id");
    if (new URL(referrer).host !== `${appId}.discordsays.com`) throw new Error("referrer host mismatch");
}

async function post(url: string, headers: Record<string, string>, body: string) {
    const res = await fetch(url, { method: "POST", headers, body, redirect: "error" });
    let parsed: any = null;
    try {
        parsed = await res.json();
    } catch { }
    return { ok: res.ok, status: res.status, body: parsed };
}

export async function discordsaysAuthorize(_, { appId, questId, referrer, code }: AuthorizeArgs) {
    checkArgs(appId, referrer);
    return post(
        `https://${appId}.discordsays.com/.proxy/acf/authorize`,
        {
            "Content-Type": "application/json",
            "X-Auth-Token": "",
            "X-Discord-Quest-ID": questId,
            Referer: referrer
        },
        JSON.stringify({ code })
    );
}

export async function discordsaysProgress(_, { appId, questId, referrer, token, progress }: ProgressArgs) {
    checkArgs(appId, referrer);
    if (!Number.isFinite(progress)) throw new Error("bad progress");
    return post(
        `https://${appId}.discordsays.com/.proxy/acf/quest/progress`,
        {
            "Content-Type": "application/json",
            "X-Auth-Token": token,
            "X-Discord-Quest-ID": questId,
            Referer: referrer
        },
        JSON.stringify({ progress: Math.floor(progress) })
    );
}

export async function solveCaptcha(_, { service, apiKey, websiteUrl, siteKey }: { service: string; apiKey: string; websiteUrl: string; siteKey: string; }) {
    if (service === "nopecha") return solveNopecha(apiKey, websiteUrl, siteKey);

    const host = SOLVER_HOSTS[service as keyof typeof SOLVER_HOSTS];
    if (!host) throw new Error("unknown captcha service");

    const createRes = await fetch(`https://${host}/createTask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            clientKey: apiKey,
            task: {
                type: "HCaptchaTaskProxyLess",
                websiteURL: websiteUrl,
                websiteKey: siteKey
            }
        })
    });
    const created = await createRes.json();
    if (created.errorId !== 0 || !created.taskId) throw new Error(`createTask failed: ${created.errorDescription ?? created.errorId}`);

    // solved tokens take a while; poll no faster than every 5s or the API starts rejecting
    for (let waited = 0; waited < 120_000; waited += 5000) {
        await new Promise(r => setTimeout(r, 5000));
        const res = await fetch(`https://${host}/getTaskResult`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientKey: apiKey, taskId: created.taskId })
        });
        const result = await res.json();
        if (result.errorId !== 0) throw new Error(`getTaskResult failed: ${result.errorDescription ?? result.errorId}`);
        if (result.status === "ready") return { token: result.solution.gRecaptchaResponse };
    }
    throw new Error("captcha solve timed out");
}
