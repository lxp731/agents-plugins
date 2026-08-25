# FAQ

- **Manual mode URL rejected?** Must be `http://` or `https://` — or a bare
  `host:port` such as `127.0.0.1:7890`, which is auto-prefixed with `http://`.
- **Direct mode** only clears DSH's proxy env vars; OS proxy is untouched.
- **Windows** proxy is read from the registry `Internet Settings`
  (`ProxyServer` / `ProxyOverride`).
- **DSH as a Windows service?** Follow system now reads the *interactive
  user's* registry hive (resolved via `Win32_ComputerSystem.UserName`) instead
  of the service account's `HKCU`, so it no longer silently goes direct under
  NSSM/LocalSystem. Manual mode is unaffected by the account.
- **Switching to Manual from the web UI?** The URL field appears first; mode
  and URL are committed atomically, so an empty URL is never rejected.
