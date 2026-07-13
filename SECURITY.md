# Security Policy

FlanTerminal provides authenticated interactive shell access. Vulnerabilities
in authentication, authorization, proxy trust, WebSocket handling, PTY or tmux
lifecycle, filesystem boundaries, container isolation, or secret handling may
have direct host and network impact.

## Supported versions

Security fixes are applied to the current `main` branch. Until tagged releases
are published, older commits and development branches are not supported.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Select **Advisories**.
3. Select **Report a vulnerability**.

Do not open a public issue or discussion containing exploit details,
credentials, private keys, hostnames, IP addresses, Access assertions, session
cookies, terminal output, or production configuration. If private vulnerability
reporting is unavailable, open a public issue containing only a request for a
private reporting channel and no sensitive technical detail.

Include the affected commit or version, deployment topology, reproduction steps,
impact, and any proposed mitigation. Use synthetic credentials and addresses
whenever possible.

## Deployment responsibility

Operators should keep the application behind local authentication or a
correctly configured identity-aware proxy, restrict direct network access, use
exact origins and narrow trusted-proxy ranges, protect both persistent volumes,
and apply container and dependency updates. Never expose `AUTH_MODE=none`.
