zmodload zsh/zpty
zpty -b comp 'env HOME=/tmp/zhome TERM=dumb PS1="R> " /usr/bin/zsh -f'
sleep 1.5
zpty -w comp 'fpath=(/tmp/zhome/dbg $fpath); autoload -Uz compinit && compinit -D; echo INIT_DONE'
sleep 3
for i in {1..15}; do zpty -r comp chunk; sleep 0.25; done >/dev/null
zpty -w -n comp $'footest \t'
sleep 3
buf=""
for i in {1..30}; do zpty -r comp chunk && buf+="$chunk"; sleep 0.25; done
print -rn -- "$buf" | cat -v | tail -2
