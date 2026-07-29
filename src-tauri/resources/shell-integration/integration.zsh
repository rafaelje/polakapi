# polakapi shell integration (zsh) — reports each submitted command via OSC
# so "Resume all" can replay it. Uses add-zsh-hook to not clobber the user's own preexec.

_polakapi_report_cmd() {
  local encoded
  encoded=$(printf '%s' "$1" | base64 | tr -d '\n')
  printf '\033]9931;%s\007' "$encoded"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _polakapi_report_cmd
