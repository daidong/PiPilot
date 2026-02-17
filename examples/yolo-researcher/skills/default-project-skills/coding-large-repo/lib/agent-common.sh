#!/usr/bin/env bash
set -euo pipefail

CODING_LARGE_REPO_TMP_DIR="${CODING_LARGE_REPO_TMP_DIR:-.yolo-researcher/tmp/coding-large-repo}"
CODING_LARGE_REPO_LOG_DIR="${CODING_LARGE_REPO_LOG_DIR:-.yolo-researcher/logs/coding-large-repo}"
CODING_LARGE_REPO_RESULT_SCHEMA="coding-large-repo.result.v1"

clrepo_print_kv() {
  local key="$1"
  local value="$2"
  echo "${key}: ${value}"
}

clrepo_join_shell_words() {
  local out=()
  for item in "$@"; do
    out+=("$(printf "%q" "$item")")
  done
  printf '%s ' "${out[@]}"
}

clrepo_json_escape() {
  local value="${1-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

clrepo_json_string_or_null() {
  local value="${1-}"
  if [[ -z "$value" ]]; then
    printf 'null'
    return 0
  fi
  printf '"%s"' "$(clrepo_json_escape "$value")"
}

clrepo_json_number_or_null() {
  local value="${1-}"
  if [[ -z "$value" ]]; then
    printf 'null'
    return 0
  fi
  if [[ ! "$value" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    printf 'null'
    return 0
  fi
  printf '%s' "$value"
}

clrepo_json_boolean_or_null() {
  local value="${1-}"
  case "$value" in
    true|TRUE|1)
      printf 'true'
      ;;
    false|FALSE|0)
      printf 'false'
      ;;
    *)
      printf 'null'
      ;;
  esac
}

clrepo_emit_result_json() {
  local payload="$1"
  echo "AF_RESULT_JSON: $payload"
}

clrepo_emit_error_result_json() {
  local script_name="$1"
  local exit_code="${2:-2}"
  local error_message="${3:-script_failed}"
  local status_label="${4:-error}"
  local payload
  payload="$(printf '{\"schema\":\"%s\",\"script\":%s,\"status\":%s,\"exit_code\":%s,\"error\":%s}' \
    "$(clrepo_json_escape "$CODING_LARGE_REPO_RESULT_SCHEMA")" \
    "$(clrepo_json_string_or_null "$script_name")" \
    "$(clrepo_json_string_or_null "$status_label")" \
    "$(clrepo_json_number_or_null "$exit_code")" \
    "$(clrepo_json_string_or_null "$error_message")")"
  clrepo_emit_result_json "$payload"
}

clrepo_compact_text() {
  local value="${1-}"
  local max_chars="${2:-400}"
  value="${value//$'\r'/ }"
  value="${value//$'\n'/ }"
  value="${value//$'\t'/ }"
  while [[ "$value" == *"  "* ]]; do
    value="${value//  / }"
  done
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ -n "$value" && "${#value}" -gt "$max_chars" ]]; then
    value="${value:0:max_chars}..."
  fi
  printf '%s' "$value"
}

clrepo_pick_timeout_runner() {
  if command -v timeout >/dev/null 2>&1; then
    echo "timeout"
    return 0
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    echo "gtimeout"
    return 0
  fi
  return 1
}

clrepo_resolve_codex_bin() {
  if command -v codex >/dev/null 2>&1; then
    command -v codex
    return 0
  fi

  local app_bin="/Applications/Codex.app/Contents/Resources/codex"
  if [[ -x "$app_bin" ]]; then
    echo "$app_bin"
    return 0
  fi

  if command -v zsh >/dev/null 2>&1; then
    local which_line
    which_line="$(zsh -ic 'which codex 2>/dev/null' 2>/dev/null || true)"
    if [[ "$which_line" == *"/Codex.app/Contents/Resources/codex"* ]]; then
      local extracted
      extracted="$(echo "$which_line" | sed -E 's/.*(\/Applications\/Codex\.app\/Contents\/Resources\/codex).*/\1/')"
      if [[ -x "$extracted" ]]; then
        echo "$extracted"
        return 0
      fi
    fi
  fi

  return 1
}

clrepo_has_claude() {
  command -v claude >/dev/null 2>&1
}

clrepo_pick_provider() {
  local requested="${1:-auto}"
  case "$requested" in
    codex)
      if clrepo_resolve_codex_bin >/dev/null 2>&1; then
        echo "codex"
        return 0
      fi
      echo "error: provider=codex requested but codex executable was not found." >&2
      return 2
      ;;
    claude)
      if clrepo_has_claude; then
        echo "claude"
        return 0
      fi
      echo "error: provider=claude requested but claude executable was not found." >&2
      return 2
      ;;
    auto|"")
      if clrepo_resolve_codex_bin >/dev/null 2>&1; then
        echo "codex"
        return 0
      fi
      if clrepo_has_claude; then
        echo "claude"
        return 0
      fi
      echo "error: no supported coding agent executable found (codex or claude)." >&2
      return 2
      ;;
    *)
      echo "error: invalid provider \"$requested\" (expected auto|codex|claude)." >&2
      return 2
      ;;
  esac
}
