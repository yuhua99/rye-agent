#!/usr/bin/env bash
set -euo pipefail

QUEUE='@pi_ready_panes'
COUNT='@pi_ready_count'
SELF="${BASH_SOURCE[0]}"

# Menu/run-shell templates expand %1-%9 and %%. Pass numeric pane ids only.
normalize_pane() {
	local raw=$1
	if [[ $raw == %* ]]; then
		printf '%s\n' "$raw"
	elif [[ $raw =~ ^[0-9]+$ ]]; then
		printf '%%%s\n' "$raw"
	else
		return 1
	fi
}

get_queue() {
	tmux show -gv "$QUEUE" 2>/dev/null || true
}

set_queue() {
	local value=${1:-}
	local n=0
	if [[ -z $value ]]; then
		tmux set -gu "$QUEUE"
		tmux set -gu "$COUNT"
	else
		tmux set -g "$QUEUE" "$value"
		n=$(wc -w <<<"$value")
		tmux set -g "$COUNT" "$n"
	fi
	tmux refresh-client -S 2>/dev/null || true
}

remove_pane() {
	local target=$1 p
	local -a next=()
	for p in $(get_queue); do
		[[ $p == "$target" ]] || next+=("$p")
	done
	if ((${#next[@]})); then
		set_queue "${next[*]}"
	else
		set_queue ""
	fi
}

pane_exists() {
	tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -Fxq "$1"
}

pane_focused() {
	local flags attached window_active pane_active
	flags=$(tmux display -p -t "$1" '#{session_attached} #{window_active} #{pane_active}' 2>/dev/null) || return 1
	read -r attached window_active pane_active <<<"$flags"
	[[ $attached != 0 && $window_active == 1 && $pane_active == 1 ]]
}

focused_client() {
	tmux list-clients -F '#{client_flags}	#{client_name}' 2>/dev/null \
		| awk -F'\t' '$1 ~ /(^|,)focused(,|$)/ { print $2; exit }'
}

prune_queue() {
	local p
	local -a alive=()
	for p in $(get_queue); do
		pane_exists "$p" || continue
		pane_focused "$p" && continue
		alive+=("$p")
	done
	if ((${#alive[@]})); then
		set_queue "${alive[*]}"
		printf '%s\n' "${alive[@]}"
	else
		set_queue ""
	fi
}

jump() {
	local pane session client
	pane=$(normalize_pane "$1") || {
		tmux display-message "π jump: bad pane id"
		return 1
	}
	client=${2:-$(focused_client || true)}

	if ! pane_exists "$pane"; then
		remove_pane "$pane"
		tmux display-message "π jump: pane gone"
		return 1
	fi

	session=$(tmux display -p -t "$pane" '#{session_name}')
	if [[ -z $session ]]; then
		remove_pane "$pane"
		tmux display-message "π jump: no session"
		return 1
	fi

	if [[ -n $client ]]; then
		tmux switch-client -c "$client" -t "=$session"
	else
		tmux switch-client -t "=$session"
	fi
	tmux select-window -t "$pane"
	tmux select-pane -t "$pane"
	remove_pane "$pane"
}

if [[ -n "${1:-}" ]]; then
	jump "$1" "${2:-}" || exit 1
	exit 0
fi

panes=()
while IFS= read -r _p; do
	[[ -n $_p ]] && panes+=("$_p")
done < <(prune_queue)
n=${#panes[@]}

if ((n == 0)); then
	tmux display-message "no π ready"
	exit 0
fi

if ((n == 1)); then
	jump "${panes[0]}" || exit 1
	exit 0
fi

client=$(focused_client || true)
menu_args=(-T "π ready")
[[ -n $client ]] && menu_args+=(-c "$client")

for pane in "${panes[@]}"; do
	label=$(tmux display -p -t "$pane" '#{session_name}:#{window_name}')
	label=${label//#/##}
	id=${pane#%}
	if [[ -n $client ]]; then
		menu_args+=("$label" "" "run-shell -b 'exec \"$SELF\" \"$id\" \"$client\"'")
	else
		menu_args+=("$label" "" "run-shell -b 'exec \"$SELF\" \"$id\"'")
	fi
done
tmux display-menu "${menu_args[@]}"
