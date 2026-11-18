# Audit app service and local site

These files serve the audit app at **http://bw-audit.localhost**, forwarding
requests to `127.0.0.1:5180`. Choose either nginx or Apache for port 80.
Access is restricted to the local machine, matching the app's existing access model.

## App service

The service resolves `npm` from systemd's `PATH`. Both `npm` and `node` must be available there; systemd does not load your interactive shell configuration.

Complete the repository setup and build described in the root README first.
Selecting SAP BW as the migration source also installs the audit app dependencies.
Install the service from the repository root:

```bash
sudo install -m 644 bw-audit/config/bw-audit.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bw-audit.service
```

Manage the app with:

```bash
sudo systemctl start bw-audit
sudo systemctl stop bw-audit
sudo systemctl restart bw-audit
systemctl status bw-audit
journalctl -u bw-audit -f
```

The service sets `PORT=5180` and `PUBLIC_ORIGIN=http://bw-audit.localhost`.
`bw-audit/.env` is still loaded by the existing start script; service environment
variables take precedence. The app continues to accept its direct localhost origins.

## nginx (Debian/Ubuntu layout)

```bash
sudo install -m 644 bw-audit/config/bw-audit.localhost.nginx.conf /etc/nginx/sites-available/bw-audit.localhost.conf
sudo ln -s /etc/nginx/sites-available/bw-audit.localhost.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## Apache (Debian/Ubuntu layout)

```bash
sudo a2enmod proxy proxy_http env authz_host
sudo install -m 644 bw-audit/config/bw-audit.localhost.apache.conf /etc/apache2/sites-available/bw-audit.localhost.conf
sudo a2ensite bw-audit.localhost.conf
sudo apache2ctl configtest
sudo systemctl restart apache2
```

Apache must listen on port 80 (the Debian/Ubuntu default). On other distributions,
adjust the site directories and Apache log paths to match the installation.

## Verify

Open `http://bw-audit.localhost`. If your resolver does not resolve the name
to loopback, add `127.0.0.1 bw-audit.localhost` to `/etc/hosts`.

```bash
curl --resolve bw-audit.localhost:80:127.0.0.1 http://bw-audit.localhost/api/audit
```

When starting the app manually behind either proxy, set the allowed origin too:

```bash
PUBLIC_ORIGIN=http://bw-audit.localhost npm run bw-audit-start
```
