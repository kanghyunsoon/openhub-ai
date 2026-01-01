# LLM privacy

OpenHub works without any language model. Recommendations, release summaries, impact verdicts and plans are deterministic.

## Optional AI summary

An optional AI summary of release notes is available:

- CLI: `openhub releases <toolId> --llm-summary --llm-model <id>`.
- Desktop: the **AI Summary** button on a release view. The first request in a session shows what will be sent and where, and asks for confirmation.

What is sent: the deterministic release summary and truncated release note text for that tool, to the OpenAI Responses API at `api.openai.com` only, with storage disabled. Project files, config files, paths and Version State are not sent.

The API key is read from `OPENAI_API_KEY` at the moment you ask for a summary. It is never stored, logged, sent to the desktop renderer or written to disk. There is no key input field.

## Display only

The AI summary is shown next to the deterministic summary and is never used for impact verdicts, version selection, plans or approvals. Release note text is passed to the model as data; instructions inside it are not followed by OpenHub. If the call fails, the deterministic summary is unchanged.
