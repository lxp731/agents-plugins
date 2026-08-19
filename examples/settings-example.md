# Settings example

The plugin registers the `network-proxy` namespace with two fields:

| field | type | default | note |
|-------|------|---------|------|
| mode  | system \| manual \| direct | system | proxy mode |
| url   | string | "" | manual-mode proxy URL (must be http(s)://) |

Manual mode example:
```json
{ "network-proxy": { "mode": "manual", "url": "http://127.0.0.1:7890" } }
```
