# polakapi shell integration (bash) — reports each submitted command via a
# custom OSC sequence so a suspended shell can be replayed on resume.

if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
fi

# Captures on submission (DEBUG trap as timing signal, `history 1` for the
# verbatim text) instead of on completion, so a still-running foreground
# command is captured too.
_polakapi_preexec() {
  if [ -n "$_polakapi_running_prompt_command" ] || [ -z "$_polakapi_prompt_active" ]; then
    return
  fi
  _polakapi_prompt_active=""
  local last
  last=$(HISTTIMEFORMAT= builtin history 1 | sed -E 's/^[[:space:]]*[0-9]+[[:space:]]*//')
  if [ -n "$last" ] && [ "$last" != "$_polakapi_last_reported" ]; then
    _polakapi_last_reported="$last"
    local encoded
    encoded=$(printf '%s' "$last" | base64 | tr -d '\n')
    printf '\033]9931;%s\007' "$encoded"
  fi
}
trap '_polakapi_preexec' DEBUG

_polakapi_precmd() {
  _polakapi_running_prompt_command=""
  _polakapi_prompt_active=1
}
# Trim trailing ";"/whitespace so splicing never produces ";;" (a syntax error).
_polakapi_orig_prompt_command="$(printf '%s' "$PROMPT_COMMAND" | sed -E 's/[[:space:];]+$//')"
PROMPT_COMMAND="_polakapi_running_prompt_command=1${_polakapi_orig_prompt_command:+; $_polakapi_orig_prompt_command}; _polakapi_precmd"
unset _polakapi_orig_prompt_command
