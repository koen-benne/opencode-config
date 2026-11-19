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

# Worktrees

- Never create a worktree without explicit human approval. Avoid worktrees for
  small tasks unless requested. An approved plan under `~/.opencode/plan`
  normally merits a dedicated worktree, but still requires explicit approval.
- The only creation path is a literal invocation of the executable
  `/home/koenbenne/.config/opencode/bin/create-worktree`; wrappers, alternate
  spellings, native `worktree_create`, direct `git worktree` creation, and
  other bypasses are denied. The script's OpenCode `ask` permission is the
  approval gate.
- Persistent worktrees use
  `/home/koenbenne/work/worktrees/<repo>/<branch-slug>`. Use `/tmp` only for
  explicitly disposable work. After creation, move the session into the new
  worktree.
- Preserve or stop services before worktree operations. Cleanup requires
  explicit human approval after services are stopped. Permission rules are
  ordered and the last matching rule wins; keep all deny rules ahead of the
  final exact-script `ask` rule.

# Git and commit history

- Follow Kent Beck's Tidy First approach: separate structural/tidying commits
  from behavioral changes, plan clean final commit boundaries from the start,
  and prefer small, coherent commits with a readable history.
- Use commit messages in the format `type(scope): Sentence case explanation`,
  with suitable Conventional Commit types such as `feat`, `fix`, `refactor`,
  `chore`, `test`, `docs`, `build`, `ci`, and `perf`.
- Create ordinary commits only with explicit user approval. Never amend,
  squash, rebase, or force-push. Proactively recommend appropriate amend or
  squash cleanup when useful, and explain how the user can perform it in
  LazyGit.
- Preserve unrelated working-tree changes.
