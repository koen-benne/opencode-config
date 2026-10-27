{
  description = "Personal OpenCode configuration";

  outputs = { self }: {
    homeManagerModules.default = { config, inputs, lib, pkgs, ... }: let
      unstable = inputs.unstable.legacyPackages.${pkgs.system};
    in {
      home.packages = [
        unstable.opencode
        unstable.opencode-desktop
        pkgs.jq
      ];

      programs.fish.shellAliases.oc = "opencode";

      # This checkout is deliberately not managed by Home Manager: OpenCode
      # needs to write plugin dependencies and service state beside its config.
      home.activation.bootstrapOpenCodeConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        target="${config.home.homeDirectory}/.config/opencode"
        repository="ssh://git@github.com:22/koen-benne/opencode-config.git"

        if [ -d "$target/.git" ]; then
          exit 0
        fi

        if [ -e "$target" ]; then
          echo "OpenCode config exists but is not a Git checkout: $target" >&2
          echo "Refusing to overwrite it." >&2
          exit 1
        fi

        mkdir -p "$(dirname "$target")"
        ${pkgs.git}/bin/git clone "$repository" "$target"
      '';
    };
  };
}
