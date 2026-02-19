#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${AF_WORKSPACE_ROOT:-}" ]]; then
  CODING_LARGE_REPO_TMP_DIR="${CODING_LARGE_REPO_TMP_DIR:-$AF_WORKSPACE_ROOT/.yolo-researcher/tmp/coding-large-repo}"
  CODING_LARGE_REPO_LOG_DIR="${CODING_LARGE_REPO_LOG_DIR:-$AF_WORKSPACE_ROOT/.yolo-researcher/logs/coding-large-repo}"
else
  CODING_LARGE_REPO_TMP_DIR="${CODING_LARGE_REPO_TMP_DIR:-.yolo-researcher/tmp/coding-large-repo}"
  CODING_LARGE_REPO_LOG_DIR="${CODING_LARGE_REPO_LOG_DIR:-.yolo-researcher/logs/coding-large-repo}"
fi
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

clrepo_has_repo_markers() {
  local dir="${1:-.}"
  [[ -d "$dir/.git" ]] \
    || [[ -f "$dir/package.json" ]] \
    || [[ -f "$dir/pyproject.toml" ]] \
    || [[ -f "$dir/requirements.txt" ]] \
    || [[ -f "$dir/setup.py" ]] \
    || [[ -f "$dir/go.mod" ]] \
    || [[ -f "$dir/Cargo.toml" ]]
}

clrepo_collect_repo_candidates() {
  local entry=""
  local rel=""
  local found_depth1="false"

  for entry in ./*; do
    [[ -d "$entry" ]] || continue
    rel="${entry#./}"
    [[ "$rel" == .* ]] && continue
    if clrepo_has_repo_markers "$entry"; then
      echo "$rel"
      found_depth1="true"
    fi
  done

  if [[ "$found_depth1" == "true" ]]; then
    return 0
  fi

  for entry in ./*/*; do
    [[ -d "$entry" ]] || continue
    rel="${entry#./}"
    [[ "$rel" == .* ]] && continue
    if clrepo_has_repo_markers "$entry"; then
      echo "$rel"
    fi
  done
}

clrepo_choose_candidate_from_hint() {
  local hint="${1-}"
  shift || true
  local hint_lc=""
  local candidate=""
  local candidate_lc=""
  local base=""
  local base_lc=""
  local bounded_hint=""

  hint_lc="$(printf '%s' "$hint" | tr '[:upper:]' '[:lower:]')"
  bounded_hint=" $hint_lc "
  [[ -n "$hint_lc" ]] || return 1

  for candidate in "$@"; do
    candidate_lc="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')"
    base="$(basename "$candidate")"
    base_lc="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]')"
    if [[ "$hint_lc" == *"$candidate_lc/"* || "$hint_lc" == *"/$candidate_lc"* || "$hint_lc" == *"$base_lc/"* ]]; then
      echo "$candidate"
      return 0
    fi
    if [[ "$bounded_hint" == *[![:alnum:]_]$base_lc[![:alnum:]_]* ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

clrepo_resolve_cwd() {
  local requested_cwd="${1-}"
  local hint_text="${2-}"
  local resolved_ref="${3:-}"
  local reason_ref="${4:-}"
  local resolved="."
  local reason="default_root"
  local matched=""

  if [[ -n "$requested_cwd" ]]; then
    resolved="$requested_cwd"
    reason="explicit_arg"
  else
    local candidates_text=""
    local -a candidates=()
    local line=""
    candidates_text="$(clrepo_collect_repo_candidates)"
    if [[ -n "$candidates_text" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] || continue
        candidates+=("$line")
      done <<< "$candidates_text"
    fi

    if [[ "${#candidates[@]}" -gt 0 ]]; then
      if matched="$(clrepo_choose_candidate_from_hint "$hint_text" "${candidates[@]}" 2>/dev/null || true)"; then
        if [[ -n "$matched" ]]; then
          resolved="$matched"
          reason="hint_match"
        fi
      fi
      if [[ "$reason" == "default_root" && "${#candidates[@]}" -eq 1 ]]; then
        if ! clrepo_has_repo_markers "."; then
          resolved="${candidates[0]}"
          reason="single_nested_repo"
        fi
      fi
    fi
  fi

  if [[ -n "$resolved_ref" ]]; then
    printf -v "$resolved_ref" '%s' "$resolved"
  else
    echo "$resolved"
  fi
  if [[ -n "$reason_ref" ]]; then
    printf -v "$reason_ref" '%s' "$reason"
  fi
}

clrepo_runtime_log_dir_for_cwd() {
  local cwd_path="${1:-.}"
  if [[ -n "${AF_WORKSPACE_ROOT:-}" ]]; then
    printf '%s/.yolo-researcher/logs/coding-large-repo' "$AF_WORKSPACE_ROOT"
    return 0
  fi
  printf '%s/.yolo-researcher/logs/coding-large-repo' "$cwd_path"
}

clrepo_runtime_tmp_dir_for_cwd() {
  local cwd_path="${1:-.}"
  if [[ -n "${AF_WORKSPACE_ROOT:-}" ]]; then
    printf '%s/.yolo-researcher/tmp/coding-large-repo' "$AF_WORKSPACE_ROOT"
    return 0
  fi
  printf '%s/.yolo-researcher/tmp/coding-large-repo' "$cwd_path"
}

clrepo_agent_session_root_for_cwd() {
  local cwd_path="${1:-.}"
  printf '%s/agent-sessions' "$(clrepo_runtime_tmp_dir_for_cwd "$cwd_path")"
}

clrepo_find_agent_session_dir() {
  local session_id="${1:-}"
  if [[ -z "$session_id" ]]; then
    return 1
  fi

  local direct="$CODING_LARGE_REPO_TMP_DIR/agent-sessions/$session_id"
  if [[ -d "$direct" ]]; then
    printf '%s' "$direct"
    return 0
  fi

  local local_root=""
  local_root="$(clrepo_agent_session_root_for_cwd ".")"
  local local_direct="$local_root/$session_id"
  if [[ -d "$local_direct" ]]; then
    printf '%s' "$local_direct"
    return 0
  fi

  local match=""
  match="$(find . -maxdepth 8 -type d -path "*/.yolo-researcher/tmp/coding-large-repo/agent-sessions/$session_id" 2>/dev/null | head -n 1 || true)"
  if [[ -n "$match" && -d "$match" ]]; then
    printf '%s' "$match"
    return 0
  fi

  return 1
}
