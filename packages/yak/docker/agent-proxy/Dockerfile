# Egress-allowlist sidecar for agent-step containment (ticket 07/08,
# .scratch/yak-engine-roadmap/map.md). Not published — built locally:
#   docker build -t yak-agent-sandbox-proxy:latest docker/agent-proxy
#
# One instance per sandboxed agent-step invocation (src/adapters/
# sandbox-network.ts). It is started on the egress network (`bridge`, or
# `podman` when that network is absent) and then attached to the step's
# `--internal` network. ALLOWED_DOMAINS (comma-separated) is rendered into
# squid.conf at container start by entrypoint.sh.
FROM ubuntu:24.04

RUN apt-get update \
  && apt-get install -y --no-install-recommends squid gettext-base \
  && rm -rf /var/lib/apt/lists/*

COPY squid.conf.template /etc/squid/squid.conf.template
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
  # Ticket 08 (real-Docker verification): some Docker runtimes enforce
  # stricter DAC checks than the norm (root doesn't implicitly bypass file
  # permissions) — the apt package's default 0755 proxy:proxy ownership on
  # /var/log/squid was enough to fail squid's own log-file open under one
  # such runtime. World-writable removes the dependency on which user
  # squid ends up running/dropping to.
  && chmod 777 /var/log/squid

EXPOSE 3128
ENTRYPOINT ["/entrypoint.sh"]
