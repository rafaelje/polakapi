# polakapi shell integration (zsh) — reports each submitted command to the
# app via a custom OSC escape sequence so a suspended shell terminal can be
# truly resumed later by replaying its last command ("Resume all"). Fires
# once per Enter-press, before execution, via zsh's own preexec hook — this
# does not overwrite any preexec the user's own .zshrc may already define,
# since add-zsh-hook appends to a list rather than replacing the function.

_polakapi_report_cmd() {
  local encoded
  encoded=$(printf '%s' "$1" | base64 | tr -d '\n')
  printf '\033]9931;%s\007' "$encoded"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _polakapi_report_cmd
