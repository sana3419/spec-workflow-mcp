# Dashboard Deployment

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SPEC_WORKFLOW_BIND_ADDRESS` | `127.0.0.1` | Network bind address (`0.0.0.0` for external access) |
| `SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS` | `false` | Must be `true` when binding to non-localhost |
| `SPEC_WORKFLOW_CORS_ORIGINS` | (none) | Extra CORS origins, comma-separated |

## Expose via reverse proxy

```bash
SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS=true \
SPEC_WORKFLOW_BIND_ADDRESS=0.0.0.0 \
SPEC_WORKFLOW_CORS_ORIGINS=https://my-domain.com \
node dist/index.js /path/to/project --dashboard --port 5000
```

## systemd service

```ini
[Unit]
Description=Spec Workflow Dashboard
After=network.target

[Service]
Type=simple
Environment=SPEC_WORKFLOW_ALLOW_EXTERNAL_ACCESS=true
Environment=SPEC_WORKFLOW_BIND_ADDRESS=0.0.0.0
Environment=SPEC_WORKFLOW_CORS_ORIGINS=https://my-domain.com
ExecStart=/usr/bin/node /path/to/dist/index.js /path/to/project --dashboard --no-open --port 5000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```
