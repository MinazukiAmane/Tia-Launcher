# Tia 1.14: game profiles

The launcher's API lookup uses `https://sg-tia-api.serenetia.com`. Requests select
`game_biz=csore_global` or `game_biz=cedar_global`, and responses must contain a
matching game entry before their package metadata is used.

The sidebar selects CSO: Re-Server Edition or Silver Palace. The selected title
is persisted. Switching is rejected while a game is starting/running or an
install, verify, repair or move operation is active.

Default installation folders are `Tia-CSORSE` and `Tia-SilverPalace`, created below
the parent chosen by the player. A valid existing Silver Palace installation can
be selected directly; its files are imported through the server repair manifest.
Selected folders, installation confirmations and game launch options are saved
per title. CSO's existing records retain their original locations. Install records
for Silver Palace carry its game biz, preventing another profile from treating
them as its own. Download/patch state is scoped to the installation path. Linux
uses a separate Wine prefix for Silver Palace while sharing the Proton download.

Silver Palace uses a separately implemented native bootstrap built from the
existing private helper repository. Public Tia code contains its launch/report
interface; it does not contain client offsets or runtime implementation scripts.
Only its Windows GUI executable, runtime DLL and third-party license are included
in installer resources. The build output directory is Git-ignored. No separate
runtime artifact publication is added. Compiler diagnostics for private source
are kept out of public CI output.

The packaged runtime starts through the existing Windows/Proton/Sikarugir launch
adapters and acknowledges success before Tia treats it as launched. Startup
errors are returned to Tia. Native fixture tests exercise the silent executable,
argument preservation, Unicode paths, initialization failure and unsupported-build
handling. These tests do not establish full game or native Windows/macOS graphics
compatibility; a real supported client still needs a device test.

The Silver Palace image and optimized video are local assets; see media-sources.md.
CSO media and game-specific options stay with the CSO profile. Launcher-wide
settings, including user-selected custom backgrounds, remain shared.

For an existing installation, select the directory containing `SilverPalace/`
(and its Binaries/Win64 executable). The server's published repair manifest must
be available. Import verifies existing assets once and downloads only missing or
corrupt assets when Repair is used. Play reuses successful hashes for unchanged
files; it does not rescan unknown files or delete extras. Logs are ignored.
Silver Palace's `SilverPalace/Saved/`, `Engine/Saved/` and root/project/engine
`DerivedDataCache/` trees are excluded even if an uploaded package accidentally
contained them. Content, packaged Config, binaries and plugins remain checked.
Runtime data in the user's AppData or Proton prefix is outside the install check.


Silver Palace announcements use the same public notice feed as the game's Roze
bulletin board. Its endpoint is supplied by the existing private-helper build in
`launcher-services.json`, whitelisted as a data-only resource. Public launcher
source and renderer IPC do not carry the endpoint. This keeps it out of the UI
and public repository; it is not a secret once installed or used on a network.

The main process independently polls every 15 minutes and refreshes on opening the
Silver Palace page or pressing refresh. It enforces the notice schedule, removes
deleted notices, orders priority/newest first, and retains the last good feed if
a refresh fails. A successful empty feed clears old notices. The reader uses the
launcher's selected language, then English, then the first available translation.
Roze currently provides English, Simplified/Traditional Chinese, Japanese and
Korean; Indonesian and Javanese fall back to English until the server adds them.

Notices, Events and News are displayed on the Silver Palace page. Clicking a row
opens Tia's own styled, scrollable reader with title, date and full content. It
never opens the system browser, embeds a remote website, or executes notice HTML.
The source's Unreal rich text is converted to ordinary text before React renders
it. CSO continues to use its existing news provider and external article links.
