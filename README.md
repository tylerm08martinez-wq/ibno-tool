<!--
  SOURCE TEMPLATE — this file is the README for the PUBLIC ibno-tool repo.
  It is shipped as README.md by scripts/deploy-ibno.sh. Edit it HERE (in the
  private source repo), never in the public mirror. Keep it DATA-FREE: no real
  repo owner/name/branch and no token — those are runtime-only (see below), and
  naming them here would leak where the private data lives (ADR-0005).
-->

# IBNO Coder

A static, browser-only tool for coding IBNO (Inbound No Van Scan) packages at the
station from the **Inbound and Van Scans — Full Detail by Date** CSV export.

This repository is a **generated, data-free mirror** of the tool. It is published
so the page is reachable on a phone and a desk browser; it contains no package
data, no credentials, and nothing about where any private data lives.

> **Do not hand-edit this repo.** It is regenerated and pushed by
> `scripts/deploy-ibno.sh` from the private source repository. Any change made
> directly here is overwritten on the next deploy.

## What it does

- Drop (or pick) the CSV export → packages are split into **Ready to Enter**
  (auto-coded by rule), **Needs Manual Review** (a person decides), **Manually
  Resolved**, and **Repeat Packages**.
- Copy/export the codes to enter them into the system.
- **Repeat History** tracks which tracking numbers have come back over a rolling
  30-day window (a Recurring IBNO = seen on 2+ distinct inbound dates), with an
  optional cross-device sync so repeats seen on one device count on another.

Everything runs in the browser. With no sync configured, all state lives only in
that browser's local storage.

## Optional: cross-device Repeat History sync

The Repeat History can sync across devices through a single JSON file in **your
own private repository**. Nothing about that repository is baked into this build —
you provide it at runtime, and it is stored only in your browser:

1. Open the page on each device.
2. **⚙ Settings → Repeat History sync.**
3. Enter:
   - a **GitHub fine-grained personal access token** scoped to **Contents:
     Read and write** on the private repo that holds the data,
   - the repo **owner**, **name**, and the dedicated **data branch**.
4. **Save sync settings.**
5. Code a report on one device; on the other, tap **Sync now** (or reload). The
   history merges (a union of inbound dates per tracking number).

Notes:
- The token lives only in your browser's local storage and travels only in the
  request authorization header — it is **never** written into the synced file or
  into this code.
- Sync is **opt-in**: with no token + coordinates entered, the tool is purely
  local and contacts nothing.
- A pruned (removed) row is a local declutter and may reappear from another
  device until it ages out of the 30-day window.

## Updating this site (maintainers)

From the private source repo, run the deploy script against a local clone of this
public repo and push:

```bash
scripts/deploy-ibno.sh <path-to-this-repo-clone> "deploy: <what changed>"
```

The script copies the data-free build (the tool as `index.html` plus its `lib/`
modules) and refuses to deploy if a real token or private repo owner is detected
in the output. GitHub Pages republishes on push.

## Security / privacy

- Keep the page reachable but treat the **token** as a standing secret in
  whatever browser you enter it; scope it to the single private repo, Contents
  only.
- The private repo stays private; only this data-free static build is public.
