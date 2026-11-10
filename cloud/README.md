# Elitejobs Hub — always-on cloud server

The same Hub engine as the Windows app, running day and night on a small Ubuntu server
behind Cloudflare Tunnel at **https://hub.elitejobsrwanda.com**.

* `install.sh` — one-line setup on a fresh Ubuntu 22.04/24.04 server (needs the Cloudflare Tunnel token).
* The engine in `../server` updates itself from this repository every 10 minutes.
* Data lives in `/var/lib/elitejobs-hub` (owned by the `hub` user, not readable by others).
* No ports are open except SSH; the Hub only listens on 127.0.0.1 and is reached through the tunnel.

Moving the office Hub into it: on the office Hub PC, IT → System control → **Move the Hub to the cloud**,
with the move code printed at the end of `install.sh`. Every PC then switches to the new address by itself.
