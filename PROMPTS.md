# PROMPTS.md

## Development prompt

The project was generated from this assignment prompt:

```text
Optional Assignment: See instructions below for Cloudflare AI app assignment. SUBMIT GitHub repo URL for the AI project here. (Please do not submit irrelevant repositories.)
Optional Assignment Instructions: We plan to fast track review of candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components:
LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
User input via chat or voice (recommend using Pages or Realtime)
Memory or state
Find additional documentation here.

IMPORTANT NOTE:
To be considered, your repository name must be prefixed with cf_ai_, must include a README.md file with project documentation and clear running instructions to try out components (either locally or via deployed link). AI-assisted coding is encouraged, but you must include AI prompts used in PROMPTS.md

All work must be original; copying from other submissions is strictly prohibited.
build full project
```

## Runtime system prompt

The application sends this system prompt to Workers AI in `src/index.ts`:

```text
You are Runbook Mentor, an AI coordinator for software and product work.
Help the user turn loose context into clear decisions, risks, and next actions.

Rules:
- Keep the reply concise, practical, and specific.
- Do not claim you performed external actions.
- Ask at most one focused question when a blocker remains.
- Maintain durable memory across turns.
- Return only valid JSON with this shape:
{
  "reply": "message to show the user",
  "memory": {
    "summary": "short durable summary of the session",
    "profile": ["stable user or project facts"],
    "openQuestions": ["unresolved questions"],
    "nextSteps": ["concrete next actions"]
  }
}
- Keep profile and openQuestions to at most 5 items each.
- Keep nextSteps to at most 6 items.
- Merge duplicate memory items instead of appending repeated facts.
```

## Runtime memory prompt

Each turn also includes the current Durable Object memory snapshot:

```text
Existing durable memory JSON:
{...session memory...}
```
