# Security policy

## Reporting a vulnerability

Please report security issues privately — do **not** open a public issue.

Open a private advisory via GitHub Security Advisories on this repository
("Security" → "Report a vulnerability"), or contact the maintainer directly.

Include the version or commit, your operating system, and the smallest reproduction you can
manage. You can expect an acknowledgement within a few days.

## Threat model

`pi-web` is a local developer tool, not a hosted service.

- The server can start the `pi` agent, and the agent can run shell commands **as the user who
  launched the server**. Anything that can send requests to the port has the same power.
- For that reason the server binds to `127.0.0.1` and rejects requests whose `Host` or `Origin`
  is not local, which blocks DNS rebinding and cross-origin requests from other browser tabs.
- `--allow-remote` removes those guards. Using it on an untrusted network is a
  misconfiguration, not a vulnerability; put authentication in front of it.
- Static file serving is confined to `public/`. Request bodies are capped at 32 MB.

## In scope

- Path traversal or arbitrary file read/write through the HTTP API.
- Request forgery that lets another web page drive the agent (loopback guard bypass).
- Script injection through rendered session content or extension UI payloads.
- Secrets or credentials leaking into logs, error responses, or the repository.

## Out of scope

- Exposing the port to a network without a proxy or authentication.
- Consequences of running the agent itself, or of prompts you send it.
- Issues that require an attacker to already have local code execution as your user.
