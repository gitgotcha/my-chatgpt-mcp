# Workers package

This package is the Cloudflare Worker ingress and future dispatch/sync host. It
has no deployed database in this repository. Before deployment, provision D1,
replace the placeholders in `wrangler.toml` locally, and configure these Worker
secrets with Wrangler:

- `INGRESS_SHARED_SECRET`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `DRIVE_ROOT_FOLDER_ID`

`INGRESS_SHARED_SECRET` is used by this task. The remaining names are reserved
for the later Dispatcher and Google Drive adapter; none may be committed in
source, configuration, test fixtures, or logs.
