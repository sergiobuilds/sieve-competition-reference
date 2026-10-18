# Sieve — competition API reference

Sieve helps accounting reviewers inspect expense evidence, applicable rules and unresolved questions before recording a human conclusion.

[Working prototype](https://sieve-180124096573.asia-northeast3.run.app) · [Demo video (3:18)](https://storage.googleapis.com/sieve-aibc-2026-submission-media/sieve-demo-public.mp4)

## Public scope

This repository contains the decision engine, Gemini/Vertex AI adapter, subsidy API, and regression tests used by the prototype. It is an executable **selected-source reference**, not a complete reproduction of the hosted product. The commercial interface, separate R&D workflow, internal rule collections, customer material and private history are excluded.

The included rule library is an independently written **fictional training policy**. It is not Korean law, a real grant program or a substitute for the hosted rule snapshot. The `patent` identifier is retained for API compatibility only. Do not use these fixtures for a real financial decision.

## Run the checks

Node.js 22 or later:

```sh
npm ci
npm test
npm run typecheck
npm run build
```

Tests use scripted model responses at the provider boundary. They exercise the real decision code without paid model calls. Test counts are reported separately from the full private product.

## Run the API with Vertex AI

Use your own Google Cloud project with Vertex AI enabled and Application Default Credentials, or a service identity with appropriate Vertex AI access. Never commit credentials. Choose available model identifiers for your project:

```sh
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-project-id
export SIEVE_READER_MODEL=your-reader-model
export SIEVE_JUDGE_MODEL=your-judge-model
export SIEVE_RECHECK_MODEL=your-recheck-model
npm start
```

The reference binds to `127.0.0.1:3000`. It is a local evaluation API, without public authentication or rate limiting. Real model calls incur usage in your project.

```sh
curl 'http://127.0.0.1:3000/api/subsidy/demo?programId=patent' -o sample.json
curl http://127.0.0.1:3000/api/subsidy/screen -H 'Content-Type: application/json' --data-binary @sample.json
```

Gemini extracts facts and answers review questions. Code compares amounts and verifies that quoted text occurs in supplied sources. Unresolved critical evidence stays visible. A quote match does not establish that a legal interpretation is correct.

## Evidence and limitations

The hosted release passed 151 product tests and 3 API integration tests. Two post-fix live requests completed, including a simulated KRW 400,000 overclaim. These are behavioral checks, not measured legal accuracy, recovered funds or human time savings. The demo uses synthetic expense evidence and identifies recorded responses.

## Rights

Copyright 2026 Sieve contributors. All rights reserved. No open-source license is granted for original project code. Public availability is provided for competition evaluation and does not grant additional commercial reuse rights. Third-party dependencies retain their respective licenses. No patents, exclusivity or eligibility determination is claimed.
