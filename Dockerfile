# Image épinglée par digest (nginx 1.31.6 alpine, relevé localement le 04/10/2026) : reconstruction reproductible.
# Mise à jour : docker pull nginx:alpine && docker image inspect nginx:alpine --format '{{index .RepoDigests 0}}'
FROM nginx:alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2

# Config nginx custom (remplace le server par défaut) : statique + proxy /api → service "api"
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Proxys de confiance pour X-Forwarded-For (sous-réseau réel de Traefik, ex. « 10.0.1.0/24 » ; IPv6 : ajouter fc00::/7).
# Vide = plages privées par défaut de nginx.conf. Chaque valeur doit être une adresse ou un CIDR (refus du build sinon).
ARG TRUSTED_PROXY_CIDRS=""
RUN set -e; if [ -n "$TRUSTED_PROXY_CIDRS" ]; then \
      lines=""; for c in $(echo "$TRUSTED_PROXY_CIDRS" | tr ',' ' '); do \
        echo "$c" | grep -Eq '^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$' || { echo "TRUSTED_PROXY_CIDRS invalide : $c" >&2; exit 1; }; \
        lines="$lines    set_real_ip_from $c;\n"; done; \
      awk -v repl="$lines" '/# BEGIN trusted-proxies/{print; printf "%s", repl; skip=1; next} /# END trusted-proxies/{skip=0} !skip' \
        /etc/nginx/conf.d/default.conf > /tmp/default.conf && cat /tmp/default.conf > /etc/nginx/conf.d/default.conf && rm /tmp/default.conf; \
    fi

# Uniquement les fichiers du site (jamais .env, backend/ ni documentation)
COPY index.html login.html confidentialite.html conditions.html /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY css/  /usr/share/nginx/html/css/
COPY js/   /usr/share/nginx/html/js/
COPY data/ /usr/share/nginx/html/data/

# Exécution NON-ROOT (utilisateur nginx, uid 101) : PID et fichiers temporaires dans /tmp (tmpfs en production),
# aucune directive « user » (inutile sans root). Le port 80 reste utilisable grâce au sysctl
# net.ipv4.ip_unprivileged_port_start=0 (défaut Docker récent, explicité dans docker-compose.yml).
RUN rm -f /usr/share/nginx/html/50x.html && chmod -R a+rX /usr/share/nginx/html \
 && sed -i -e '/^user /d' -e 's#^pid .*#pid /tmp/nginx.pid;#' /etc/nginx/nginx.conf \
 && sed -i 's#^http {#http {\n    client_body_temp_path /tmp/client_temp;\n    proxy_temp_path /tmp/proxy_temp;\n    fastcgi_temp_path /tmp/fastcgi_temp;\n    uwsgi_temp_path /tmp/uwsgi_temp;\n    scgi_temp_path /tmp/scgi_temp;#' /etc/nginx/nginx.conf \
 && chown -R nginx:nginx /var/cache/nginx \
 && nginx -t && rm -rf /tmp/* # résidus root de « nginx -t » (pid) : l’image doit démarrer aussi sans tmpfs

USER nginx
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
