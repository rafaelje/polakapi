# polakapi shell integration (bash), sourced via `bash --init-file` for a bare
# shell terminal spawn — reports each submitted command to the app via a
# custom OSC escape sequence so a suspended shell terminal can be truly
# resumed later by replaying its last command ("Resume all"). `--init-file`
# replaces ~/.bashrc for this session, so this sources it explicitly first.

if [ -f "$HOME/.bashrc" ]; then
  source "$HOME/.bashrc"
fi

_polakapi_report_cmd() {
  local last
  last=$(HISTTIMEFORMAT= builtin history 1 | sed -E 's/^[[:space:]]*[0-9]+[[:space:]]*//')
  if [ -n "$last" ] && [ "$last" != "$_polakapi_last_reported" ]; then
    _polakapi_last_reported="$last"
    local encoded
    encoded=$(printf '%s' "$last" | base64 | tr -d '\n')
    printf '\033]9931;%s\007' "$encoded"
  fi
}

PROMPT_COMMAND="_polakapi_report_cmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
