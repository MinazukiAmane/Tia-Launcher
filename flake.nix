{
  description = "Tia Launcher";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      runtime = builtins.fromJSON (builtins.readFile ./nix/native-runtimes.json);
      nativeRuntimes = pkgs.runCommand "tia-launcher-native-runtimes" {
        src = pkgs.fetchurl { inherit (runtime) url hash; };
      } ''
        mkdir -p "$out"
        tar -xzf "$src" -C "$out"
      '';
      package = pkgs.callPackage ./nix/package.nix { inherit nativeRuntimes; };
    in {
      packages.${system} = { default = package; tia-launcher = package; };
      overlays.default = final: prev: { tia-launcher = self.packages.${prev.stdenv.hostPlatform.system}.default; };
      nixosModules.default = { config, lib, pkgs, ... }:
        let cfg = config.programs.tia-launcher; in {
          options.programs.tia-launcher = {
            enable = lib.mkEnableOption "Tia Launcher";
            package = lib.mkOption { type = lib.types.package; default = self.packages.${pkgs.stdenv.hostPlatform.system}.default; description = "Tia Launcher package."; };
          };
          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ cfg.package ];
            hardware.graphics.enable = lib.mkDefault true;
            hardware.graphics.enable32Bit = lib.mkDefault pkgs.stdenv.hostPlatform.isx86_64;
            xdg.portal.enable = lib.mkDefault true;
            xdg.portal.extraPortals = [ pkgs.xdg-desktop-portal-gtk ];
          };
        };
      checks.${system}.package = package;
      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ package ];
        packages = with pkgs; [ cargo rustc nodejs_24 cargo-tauri ];
      };
    };
}
