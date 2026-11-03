    # Folder uploads send one audio file per request.
    client_max_body_size 1024m;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    add_header X-Frame-Options DENY always;
    add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; script-src 'self'; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://login.yotoplay.com" always;

    root /var/www/audio.benlocher.com/frontend/dist;
    index index.html;

    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location /assets/ {
        try_files $uri =404;
        expires 30d;
        add_header Cache-Control "public, max-age=2592000, immutable";
    }

    location /static/ {
        alias /var/www/audio.benlocher.com/backend/staticfiles/;
        try_files $uri =404;
        expires 7d;
    }

    # Only reachable through X-Accel-Redirect from Django's signed-in /api/media/ view.
    location /protected-media/ {
        internal;
        alias /var/lib/audio/media/;
        add_header Accept-Ranges bytes always;
        gzip off;
    }

    location /api/ {
        proxy_pass http://backend_audio;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_connect_timeout 75s;
        proxy_request_buffering off;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_redirect off;
        proxy_buffering off;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
