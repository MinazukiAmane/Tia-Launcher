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
