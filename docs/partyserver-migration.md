# Multiplayer deployment

The shared backend is deployed by Cloudflare Workers Builds from Farl/websim-socket.
GitHub Pages continues to serve this site at its existing URL and room names stay unchanged.

After verifying the backend, set the GitHub repository variable `PARTYSERVER_HOST`
to its hostname (without a scheme or path), then run the Pages workflow.
A missing or invalid host fails the build before Pages deployment.
For local use, run `PARTYSERVER_HOST=localhost:1999 node scripts/prepare-env.mjs`.
The exported `PARTYKIT_HOST` name is retained for client compatibility.
