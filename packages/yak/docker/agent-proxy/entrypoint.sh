#!/bin/sh
set -eu

# ALLOWED_DOMAINS is comma-separated (e.g. "api.anthropic.com"); squid's
# dstdomain ACL wants whitespace-separated tokens.
ACL_LIST=$(echo "${ALLOWED_DOMAINS:-}" | tr ',' ' ')
export ALLOWED_DOMAINS_ACL="$ACL_LIST"

envsubst '${ALLOWED_DOMAINS_ACL}' < /etc/squid/squid.conf.template > /etc/squid/squid.conf

exec squid -N -d 1
