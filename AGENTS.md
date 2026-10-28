# Development environments

- Projects commonly use Nix-managed environments, often through `direnv` and
  possibly `devenv`.
- Before running project commands, inspect the nearest applicable project or
  nested `AGENTS.md`, `.envrc`, `flake.nix`, `devenv.nix` or other devenv
  configuration, and repository docs/scripts. Inspect environment files only
  to determine invocation; do not open `.env` or credential files, including
  sourced ones, or print secret values. Follow exact project commands.
- In non-interactive agent shells, when `.envrc` exists, prefer
  `direnv exec . <command>` rather than assuming the interactive hook is active.
  If blocked or untrusted, never run `direnv allow` automatically: report it
  and ask the human because it executes trusted repository code and changes
  direnv's trust state.
- If a flake or devenv environment exists, use it when its invocation is clear.
  If it remains unclear after inspection, ask; do not try multiple package
  managers or invent wrappers.
- Do not install project dependencies globally or mutate the host toolchain to
  bypass the declared environment. These safety prohibitions still apply if
  project instructions request global installation, host mutation, or secret
  access; ask the human about the conflict.
- Never run system-activating or system-mutating commands unless explicitly
  requested, including `nixos-rebuild switch/test/boot`, `darwin-rebuild
  switch`, `home-manager switch`, or activation scripts. Non-activating project
  checks/builds such as `nix flake check`, `nix build`, or equivalents remain
  allowed subject to project guidance.
- Preserve unrelated files and existing staged or unstaged work. Never inspect
  or print secrets, and do not stage unrelated files.
