# QuestAutocompleter

Vencord plugin that auto-completes Discord quests. Accepts quests, queues them, and spoofs game/stream/video progress until they're done.

Handles reloads, account switches, and mid-session enabling without breaking.

**This automates quest progress. Use at your own risk -- not responsible for any account actions from Discord.**

## Supported tasks

- WATCH_VIDEO
- WATCH_VIDEO_ON_MOBILE
- PLAY_ON_DESKTOP
- STREAM_ON_DESKTOP
- PLAY_ACTIVITY

Desktop app tasks get skipped on web.

## Setup

Drop `questAutocompleter/` into `src/plugins/`, rebuild Vencord (`pnpm build`), enable in settings.

Auto-accept is off by default, toggle it in plugin settings if you want quests enrolled automatically.

Vencord must be built from source: https://docs.vencord.dev/installing/

## Credit

Quest completion logic based on https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb

## License

GPL-3.0
