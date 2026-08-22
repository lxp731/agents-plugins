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
complete -c dshctl -n '__fish_use_subcommand' -a enable -d 'create systemd units (service + watchdog) and enable boot autostart'
complete -c dshctl -n '__fish_use_subcommand' -a disable -d 'disable boot autostart, stop watchdog, and remove unit files'
complete -c dshctl -n '__fish_use_subcommand' -a probe -d 'ping /dsh-health and report reachability/latency'
complete -c dshctl -n '__fish_use_subcommand' -a info -d 'show overview (profile/unit/pid/port/watchdog/version)'
complete -c dshctl -n '__fish_use_subcommand' -a doctor -d 'run one-shot self-diagnostics'
complete -c dshctl -n '__fish_use_subcommand' -a logs -d 'view dsh log (dsh) or systemd journal (journal); -f to follow'
complete -c dshctl -n '__fish_use_subcommand' -a config -d 'view/set persisted config'
complete -c dshctl -n '__fish_use_subcommand' -a diagnostics -d 'export a diagnostics bundle'
complete -c dshctl -n '__fish_use_subcommand' -a up -d 'alias for start'
complete -c dshctl -n '__fish_use_subcommand' -a down -d 'alias for stop'
complete -c dshctl -n '__fish_use_subcommand' -a reload -d 'alias for restart'
complete -c dshctl -n '__fish_use_subcommand' -a on -d 'alias for enable'
complete -c dshctl -n '__fish_use_subcommand' -a off -d 'alias for disable'
complete -c dshctl -n '__fish_use_subcommand' -a ps -d 'alias for status'
complete -c dshctl -n '__fish_use_subcommand' -a h -d 'alias for probe'
complete -c dshctl -n '__fish_use_subcommand' -a d -d 'alias for doctor'
complete -c dshctl -n '__fish_use_subcommand' -a l -d 'alias for logs'
complete -c dshctl -n '__fish_use_subcommand' -a i -d 'alias for info'
complete -c dshctl -n '__fish_use_subcommand' -a setup -d 'link CLI to PATH and install shell completion'
complete -c dshctl -n '__fish_use_subcommand' -a uninstall -d 'remove CLI link, completions, and systemd units'
complete -c dshctl -l profile -s p -d 'profile under ~/.dsh/profiles' -a '(__dshctl_profiles)'
