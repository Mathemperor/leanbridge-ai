# Browser access for the owner/judge workbench

Set `LEANBRIDGE_ACCESS_PASSWORD` privately alongside the provider key and `LEANBRIDGE_BACKEND_TOKEN`. Use an independently generated random password of 16–256 characters. Never reuse an API key or backend token. The preflight launcher copies this setting from local `.env` to `.env.docker` without displaying it.

Open the application and sign in with the access password. It is exchanged for an opaque, HttpOnly, SameSite=Strict cookie. No provider key or backend token is sent to the browser or saved in browser storage. Sign out revokes the session; sessions also expire after eight hours and on a server restart. Operational clients can continue using the backend bearer token.

Remote deployments require HTTPS and must preserve the original `Host` header. Keep the frontend and API on the same origin. Loopback HTTP (`localhost` or `127.0.0.1`) is supported for local testing. Do not enable permissive CORS or forward untrusted authorization headers. Login failures are bounded to ten per connection IP per fifteen minutes; a reverse proxy shares this limit unless a separately reviewed proxy/IP configuration is introduced.

This is a shared demonstration workbench for the owner and invited judges. All authenticated reviewers share the in-memory proof store. It is not a multi-tenant service: use one instance per trust group and do not upload private proofs to a shared demo. Keep the access password in the private judge-access section of the competition submission, never in the public repository or video.

The default Nebius model supports LaTeX/text input; its image tab is disabled. A configured Lean environment is not evidence of readiness: use the authenticated `/api/ready` endpoint to check the real compiler.
