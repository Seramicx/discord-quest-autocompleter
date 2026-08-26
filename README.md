# QuestAutocompleter

Vencord plugin that auto-completes Discord quests. Accepts quests, queues them, and spoofs game/stream/video progress until they're done.

Handles reloads, account switches, and mid-session enabling without breaking.

## Disclaimer

This plugin automates Discord quest progress. Use it at your own risk and make sure you understand Discord's Terms of Service.

I am not responsible for any account actions, flags, or bans that may occur from using this plugin.

## Supported tasks

- WATCH_VIDEO
- WATCH_VIDEO_ON_MOBILE
- PLAY_ON_DESKTOP
- STREAM_ON_DESKTOP
- PLAY_ACTIVITY
- ACHIEVEMENT_IN_ACTIVITY

Desktop app tasks get skipped on web.

## Setup/Install

Download `questAutocompleter.zip` from the latest release. Unzip, and make sure there is only 1 folder housing the .tsx file inside it. 

Paste the folder into `Vencord/src/plugins/`, mimicking the same file structure as other plugins. Rebuild Vencord (`pnpm build`), enable in settings.

Auto-accept is off by default, toggle it in plugin settings if you want quests enrolled automatically.

The plugin asks Discord for new quests every 2 hours. Change that in settings, minimum is 30 minutes.

Vencord must be built from source: https://docs.vencord.dev/installing/

## Achievement quests

Achievement quests (earn badges inside an activity) are handled automatically via OAuth. The plugin authorizes itself with the activity, then fires off the badge completion request. On by default, can be toggled with "Achievement Bypass" in settings.

## Auto-claim

When a quest finishes, the plugin can automatically claim the reward for you. This requires a captcha solver since Discord gates claims behind hCaptcha.

Turn on "Auto Claim" in settings, pick a solver (NopeCHA, CapSolver, or 2Captcha), and paste your API key. If the solve fails or the key is missing, the quest just stays completed without claiming -- you can still claim manually.

## Credit

Quest completion logic based on https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb

## License

GPL-3.0