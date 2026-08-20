# bash completion for dshctl — source from .bashrc or place in
# ~/.local/share/bash-completion/completions/dshctl

_dshctl() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  local cmds="status start stop restart open"

  case "$prev" in
    --profile|-p)
      COMPREPLY=($(compgen -W "$(ls ~/.dsh/profiles 2>/dev/null | grep -v node_modules)" -- "$cur"))
      return 0
      ;;
  esac

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "--profile" -- "$cur"))
  else
    COMPREPLY=($(compgen -W "$cmds" -- "$cur"))
  fi
  return 0
}
complete -F _dshctl dshctl
