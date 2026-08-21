# QuestAutocompleter

Vencord plugin that auto-completes Discord quests. Accepts quests, queues them, and spoofs game/stream/video progress until they're done.

Handles reloads, account switches, and mid-session enabling without breaking.

## ⚠️ Disclaimer

This plugin automates Discord quest progress. Use it at your own risk and make sure you understand Discord’s Terms of Service.

I am not responsible for any account actions, flags, or bans that may occur from using this plugin.

## Supported tasks

- WATCH_VIDEO
- WATCH_VIDEO_ON_MOBILE
- PLAY_ON_DESKTOP
- STREAM_ON_DESKTOP
- PLAY_ACTIVITY

Desktop app tasks get skipped on web.

## Setup/Install

Download `questAutocompleter.zip` from the latest release. Unzip, and make sure there is only 1 folder housing the .tsx file inside it. 

Paste the folder into `Vencord/src/plugins/`, mimicking the same file structure as other plugins. Rebuild Vencord (`pnpm build`), enable in settings.

Auto-accept is off by default, toggle it in plugin settings if you want quests enrolled automatically.

The plugin asks Discord for new quests every 2 hours. Change that in settings, minimum is 30 minutes.

Vencord must be built from source: https://docs.vencord.dev/installing/

## Credit

Quest completion logic based on https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb

## License

GPL-3.0
