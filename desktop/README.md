# Elitejobs Hub — Windows app

The desktop wrapper for the Hub. The server code (`../server/*.js`) and the screen (`../index.html`) are copied in at build time.

Build the installer on GitHub (a real Windows machine): Actions → **Build Hub for Windows** → Run workflow.
It builds `Elitejobs-Hub-Setup-<version>.exe` from `server/package.json`'s version and puts it, with `latest.yml`, in `downloads/`.
