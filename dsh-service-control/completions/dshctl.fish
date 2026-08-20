# fish completion for dshctl — auto-loaded from ~/.config/fish/completions/

function __dshctl_profiles
    ls ~/.dsh/profiles 2>/dev/null | grep -v node_modules
end

complete -c dshctl -f
complete -c dshctl -n '__fish_use_subcommand' -a status -d 'show service status (running/pid/port)'
complete -c dshctl -n '__fish_use_subcommand' -a start -d 'start the dsh service in background'
complete -c dshctl -n '__fish_use_subcommand' -a stop -d 'stop the running dsh service'
complete -c dshctl -n '__fish_use_subcommand' -a restart -d 'restart the dsh service'
complete -c dshctl -n '__fish_use_subcommand' -a open -d 'open the service URL in the default browser'
complete -c dshctl -n '__fish_use_subcommand' -a setup -d 'link CLI to PATH and install shell completion'
complete -c dshctl -n '__fish_use_subcommand' -a uninstall -d 'remove CLI link and installed completions'
complete -c dshctl -l profile -s p -d 'profile under ~/.dsh/profiles' -a '(__dshctl_profiles)'
