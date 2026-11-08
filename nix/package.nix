{ lib, stdenv, rustPlatform, buildNpmPackage, importNpmLock, fetchurl, pkg-config
, wrapGAppsHook3, makeWrapper, gtk3, webkitgtk_4_1, libayatana-appindicator
, gst_all_1, ffmpeg, umu-launcher, xdg-utils, appimageTools, nativeRuntimes
}:
let
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  source = lib.cleanSourceWith {
    src = ../.;
    filter = path: type: !(builtins.elem (baseNameOf path) [ ".git" ".idea" "node_modules" "target" "dist" "release" "release-test" "migration-secrets" ".private-helper" "ref" ]);
  };
  frontend = buildNpmPackage {
    pname = "tia-launcher-frontend";
    inherit version;
    src = source;
    npmDeps = importNpmLock { npmRoot = source; };
    npmConfigHook = importNpmLock.npmConfigHook;
    npmFlags = [ "--ignore-scripts" ];
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    npmBuildScript = "build";
    installPhase = "mkdir -p $out; cp -r dist/. $out/";
  };
in
assert lib.versionAtLeast umu-launcher.version "1.4.4";
rustPlatform.buildRustPackage {
  pname = "tia-launcher";
  inherit version;
  src = source;
  cargoLock.lockFile = ../src-tauri/Cargo.lock;
  buildAndTestSubdir = "src-tauri";
  nativeBuildInputs = [ pkg-config wrapGAppsHook3 makeWrapper ];
  buildInputs = [ gtk3 webkitgtk_4_1 libayatana-appindicator gst_all_1.gstreamer gst_all_1.gst-plugins-base gst_all_1.gst-plugins-good gst_all_1.gst-plugins-bad gst_all_1.gst-libav ];
  cargoBuildFlags = [ "--bin" "tia-launcher" "--features" "tauri/custom-protocol" ];
  cargoTestFlags = [ "--no-default-features" ];
  TAURI_CONFIG = builtins.readFile ../src-tauri/tauri.production.conf.json;
  preBuild = ''
    cp -r ${frontend} dist
    mkdir -p build/native/cedar
    cp ${nativeRuntimes}/client-runtime/csore-start-*.exe build/native/
    cp ${nativeRuntimes}/game-runtime/* build/native/cedar/
  '';
  installPhase = ''
    runHook preInstall
    install -Dm755 target/release/tia-launcher "$out/bin/tia-launcher"
    mkdir -p "$out/lib/Tia Launcher"
    cp -r ${nativeRuntimes}/client-runtime ${nativeRuntimes}/game-runtime "$out/lib/Tia Launcher/"
    cp -r build/licenses "$out/lib/Tia Launcher/"
    printf 'nix\n' > "$out/lib/Tia Launcher/package-type"
    install -Dm644 build/icon.png "$out/share/icons/hicolor/512x512/apps/tia-launcher.png"
    mkdir -p "$out/share/applications"
    cat > "$out/share/applications/tia-launcher.desktop" <<DESKTOP
    [Desktop Entry]
    Type=Application
    Name=Tia Launcher
    Exec=$out/bin/tia-launcher
    Icon=tia-launcher
    Categories=Game;
    Terminal=false
    DESKTOP
    runHook postInstall
  '';
  preFixup = ''
    gappsWrapperArgs+=(
      --prefix PATH : ${lib.makeBinPath [ ffmpeg umu-launcher xdg-utils ]}
      --set TIA_UMU_LAUNCHER ${lib.getExe umu-launcher}
    )
  '';
  meta = {
    description = "Tia game library";
    homepage = "https://tia-launcher.serenetia.com";
    platforms = [ "x86_64-linux" ];
    mainProgram = "tia-launcher";
    sourceProvenance = with lib.sourceTypes; [ fromSource binaryNativeCode ];
  };
}
