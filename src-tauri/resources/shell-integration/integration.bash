# polakapi shell integration (bash) — reports each submitted command via a
# custom OSC sequence so a suspended shell can be replayed on resume.

if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
fi

_polakapi_histnum() {
  HISTTIMEFORMAT= builtin history 1 | head -n1 | sed -E 's/^[[:space:]]*([0-9]+).*/\1/'
}

# Captures on submission (DEBUG trap as timing signal, `history 1` for the
# verbatim text) instead of on completion, so a still-running foreground
# command is captured too.
_polakapi_preexec() {
  # PROMPT_COMMAND re-runs on empty Enter / Ctrl+C; never treat our own
  # bookkeeping commands as user input.
  case "$BASH_COMMAND" in _polakapi_*) return ;; esac
  if [ -n "$_polakapi_running_prompt_command" ] || [ -z "$_polakapi_prompt_active" ]; then
    return
  fi
  _polakapi_prompt_active=""
  local num
  num=$(_polakapi_histnum)
  # Only report when history grew in THIS session — otherwise `history 1` is
  # the tail of the shared HISTFILE (a command from some other terminal).
  if [ -z "$num" ] || [ "$num" = "$_polakapi_last_histnum" ]; then
    return
  fi
  _polakapi_last_histnum="$num"
  local last encoded
  last=$(HISTTIMEFORMAT= builtin history 1 | sed -E '1s/^[[:space:]]*[0-9]+[[:space:]]*//')
  if [ -n "$last" ]; then
    encoded=$(printf '%s' "$last" | base64 | tr -d '\n')
    printf '\033]9931;%s\007' "$encoded"
  fi
}
_polakapi_last_histnum=$(_polakapi_histnum)
trap '_polakapi_preexec' DEBUG

_polakapi_precmd() {
  _polakapi_running_prompt_command=""
  _polakapi_prompt_active=1
}
# Trim trailing ";"/whitespace so splicing never produces ";;" (a syntax error).
_polakapi_orig_prompt_command="$(printf '%s' "$PROMPT_COMMAND" | sed -E 's/[[:space:];]+$//')"
PROMPT_COMMAND="_polakapi_running_prompt_command=1${_polakapi_orig_prompt_command:+; $_polakapi_orig_prompt_command}; _polakapi_precmd"
unset _polakapi_orig_prompt_command
