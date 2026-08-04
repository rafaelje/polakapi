# polakapi shell integration (zsh) — reports each submitted command via OSC
# so "Resume all" can replay it. Uses add-zsh-hook to not clobber the user's own preexec.

_polakapi_report_cmd() {
  local encoded first flag
  # Flag alias/function commands so the app can allow replaying them.
  first=${1%%[[:space:]]*}
  flag=c
  case "$(whence -w -- "$first" 2>/dev/null)" in
    *": alias" | *": function") flag=a ;;
  esac
  encoded=$(printf '%s' "$1" | base64 | tr -d '\n')
  printf '\033]9931;%s;%s\007' "$flag" "$encoded"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _polakapi_report_cmd
