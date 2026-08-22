# bash completion for dshctl — source from .bashrc or place in
# ~/.local/share/bash-completion/completions/dshctl

_dshctl() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local cmds="status start stop restart open enable disable probe info doctor logs config diagnostics setup uninstall"
  local aliases="up down reload on off ps h d l i"
  local logs_src="dsh journal"

  case "$prev" in
    --profile|-p)
      COMPREPLY=($(compgen -W "$(ls ~/.dsh/profiles 2>/dev/null | grep -v node_modules)" -- "$cur"))
      return 0
      ;;
    logs|l)
      COMPREPLY=($(compgen -W "$logs_src" -- "$cur"))
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "--profile" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$cmds $aliases" -- "$cur"))
  fi
  return 0
}
complete -F _dshctl dshctl
