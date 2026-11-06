{
  description = "Personal OpenCode configuration";

  outputs = { self }: {
    homeManagerModules.default = { config, inputs, lib, pkgs, ... }: let
      unstable = inputs.unstable.legacyPackages.${pkgs.stdenv.hostPlatform.system};
      cfg = config.programs.opencodeConfig;
    in {
      options.programs.opencodeConfig = {
        enable = lib.mkEnableOption "OpenCode configuration";

        desktop.enable = lib.mkEnableOption "OpenCode desktop";
      };

      config = lib.mkIf cfg.enable {
        home.packages = [
          unstable.opencode
          pkgs.jq
        ] ++ lib.optional cfg.desktop.enable unstable.opencode-desktop;

        programs.fish.shellAliases.oc = "opencode";

        # This checkout is deliberately not managed by Home Manager: OpenCode
        # needs to write plugin dependencies and service state beside its config.
        home.activation.bootstrapOpenCodeConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          target="${config.home.homeDirectory}/.config/opencode"
          repository="https://github.com/koen-benne/opencode-config.git"

          if [ -d "$target/.git" ]; then
            :
          elif [ -e "$target" ]; then
            echo "OpenCode config exists but is not a Git checkout: $target" >&2
            echo "Refusing to overwrite it." >&2
            exit 1
          else
            run ${pkgs.coreutils}/bin/mkdir -p "$(dirname "$target")"
            run ${pkgs.git}/bin/git clone "$repository" "$target"
          fi
        '';
      };
    };
  };
}
