FROM nginx:alpine

# Config nginx custom (remplace le server par défaut) : statique + proxy /api → service "api"
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Uniquement les fichiers du site (jamais .env, backend/ ni documentation)
COPY index.html login.html confidentialite.html conditions.html /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY css/  /usr/share/nginx/html/css/
COPY js/   /usr/share/nginx/html/js/
COPY data/ /usr/share/nginx/html/data/

RUN rm -f /usr/share/nginx/html/50x.html && chmod -R a+rX /usr/share/nginx/html && nginx -t

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

STOPSIGNAL SIGQUIT
CMD ["nginx", "-g", "daemon off;"]
