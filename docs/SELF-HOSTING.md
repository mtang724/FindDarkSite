# Self-hosting FindDarkSite (Ubuntu + nginx + your own domain)

A runbook for deploying the **public** build on your own server. Followable
top-to-bottom — by a human or by Claude reading this repo on the deploy machine.

## What the public build includes (and the one thing it must not)

- ✅ **VIIRS 2023** national scan + the **✨ Sky-glow** modeled layer — the
  Sky-glow layer gives **Bortle 1/2/3** gradation and is fully distributable
  (derived from public-domain VIIRS + CC-BY GLOBE at Night). On a fresh clone
  the app auto-selects Sky-glow, so the public site **does** show Bortle 1/2/3.
- ✅ IDA Dark Sky Places, GLOBE at Night, Reddit community spots — all
  distributable with attribution.
- 🚫 **World Atlas 2015 (Falchi)** — license-restricted, **never** in the repo
  (gitignored) and **never** in `dist/`. A fresh clone simply doesn't have it,
  so there's nothing to leak. The `build:deploy` script enforces this anyway.

> A fresh clone is the safest deploy source: it physically cannot contain the
> restricted World Atlas data, because that data was never pushed.

## 0. Prerequisites on the server

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
# Node 20+ (nodesource or nvm); verify:
node -v && npm -v
# DNS: point your domain's A/AAAA record at this server's IP first.
```

## 1. Clone + build (license-guarded)

```bash
git clone https://github.com/mtang724/FindDarkSite.git
cd FindDarkSite
npm install
npm run build:deploy          # NOT `npm run build` — this scrubs + verifies + gzips
```

`build:deploy` (`scripts/build-deploy.mjs`) runs `vite build`, then:
- deletes any `dist/data/*worldatlas*.json` and strips worldatlas from
  `dist/data/index.json`,
- **fails loudly** if any World Atlas data survives in `dist/data/`,
- pre-gzips the big scan JSON (71 MB → ~4 MB) for nginx `gzip_static`.

Output is `dist/`. Confirm it shipped Bortle 1/2/3:
```bash
grep -o 'skyglow' dist/data/index.json | head -1   # → skyglow  (present)
ls dist/data/*worldatlas* 2>/dev/null || echo "clean (no World Atlas)"
```

## 2. Put `dist/` where nginx serves it

```bash
sudo mkdir -p /var/www/finddarksite
sudo rsync -a --delete dist/ /var/www/finddarksite/
```

## 3. nginx site config

`/etc/nginx/sites-available/finddarksite` (replace `yourdomain.com`):

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    root /var/www/finddarksite;
    index index.html;

    location / { try_files $uri $uri/ /index.html; }

    # Big scan JSON: serve the pre-gzipped .gz (build:deploy made them).
    gzip on;
    gzip_types application/json application/javascript text/css image/svg+xml;
    gzip_min_length 1024;
    location /data/ {
        gzip_static on;
        add_header Cache-Control "public, max-age=86400";
    }

    # ── Reverse-proxy the same upstreams the Vite dev server proxies, so the
    #    live astro/weather/facility features work without CORS. ──
    location /api/7timer {                       # seeing + transparency
        proxy_pass https://www.7timer.info/bin/astro.php;
        proxy_set_header Host www.7timer.info;
        proxy_ssl_server_name on;
    }
    location /api/ridb {                         # campgrounds (needs RIDB key in app config)
        proxy_pass https://ridb.recreation.gov/api/v1;
        proxy_set_header Host ridb.recreation.gov;
        proxy_ssl_server_name on;
    }
    location /api/lp {                           # only used if a visitor picks "Use Live API"
        proxy_pass https://www.lightpollutionmap.info/geoserver/gwc/service/wms;
        proxy_set_header Host www.lightpollutionmap.info;
        proxy_ssl_server_name on;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/finddarksite /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## 4. HTTPS (required for the PWA / service worker)

```bash
sudo certbot --nginx -d yourdomain.com    # adds the 443 server block + auto-renew
```

## 5. Verify

- Visit `https://yourdomain.com` — map loads, search works.
- Enter a remote location (e.g. `38.5, -98.5`) → the source indicator should
  read **✨ Auto: ✨ Sky-glow National CONUS**, and dark results show
  **Bortle 1/2/3** (not all floored to 1).
- These work directly (no proxy): Overpass, Open-Meteo, OSRM, Nominatim.
- 7Timer seeing/transparency works via the `/api/7timer` proxy above.

## Notes

- **No proxy? Graceful degradation.** If you skip the nginx `/api/*` blocks,
  the core finder still works; only 7Timer seeing/transparency and RIDB
  campgrounds go missing.
- **Subpath deploy** (e.g. `yourdomain.com/finddarksite/`): set
  `base: '/finddarksite/'` in `vite.config.js` before building. Root domain
  needs nothing.
- **Refreshing data:** re-run the fetchers in `scripts/` and
  `scanner/skyglow/calibrate-rings.mjs --write-scan`, then re-run
  `npm run build:deploy` and rsync again.
- **RIDB campgrounds** need an API key (`CONFIG.RIDB_API_KEY`); without one the
  app just omits campground POIs.
