# SeeStar Night Desk

Private, local browser dashboard for the SeeStar S50. It binds only to
`127.0.0.1` and talks to the telescope directly on your local network.

```bash
cd /home/sdonato/ChatGPTTests/seestar-dashboard
node server.js
```

Open http://127.0.0.1:8787. The supplied S50 integration key is read from
`../seestar-cli/seestar.pem`; keep that private.
