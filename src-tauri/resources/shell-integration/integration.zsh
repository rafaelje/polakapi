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
  printf '\033]9931;%s;%s;%s\007' "$_polakapi_shell_token" "$flag" "$encoded"
}

autoload -Uz add-zsh-hook
add-zsh-hook preexec _polakapi_report_cmd

# End output before zsh adds its partial-line marker and padding, not at precmd.
PROMPT_EOL_MARK="%{"$'\033]9933;'"${_polakapi_shell_token}"$'\007'"%}${PROMPT_EOL_MARK-%B%S%#%s%b}"

# Reports that the previous command finished, with its exit status, so the
# app can tell when a command it typed is done.
_polakapi_report_done() {
  local polakapi_status=$?
  printf '\033]9932;%s;%s\007' "$_polakapi_shell_token" "$polakapi_status"
}
add-zsh-hook precmd _polakapi_report_done
