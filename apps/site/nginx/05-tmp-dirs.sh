#!/bin/sh
# Runs before the nginx image's envsubst step: with a read-only root filesystem the rendered
# config and nginx's temp paths go to /tmp (an emptyDir / tmpfs that starts empty).
set -eu
mkdir -p /tmp/nginx/conf.d /tmp/nginx/client_temp /tmp/nginx/proxy_temp /tmp/nginx/fastcgi_temp /tmp/nginx/uwsgi_temp /tmp/nginx/scgi_temp
