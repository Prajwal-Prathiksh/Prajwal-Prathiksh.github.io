# Commit messages

Write a subject and body for every commit in this repository.

- Keep the subject short and specific. Use the affected game or area as a prefix when it helps, such as `Chowka Bhara: smarter opponents and board history` or `Playroom: wider game grid`.
- Leave one blank line after the subject. In the body, explain what changed and why. Use separate paragraphs for distinct changes and wrap lines at about 72 characters.
- For an agent-authored commit, leave one blank line after the body and end with exactly one `Co-Authored-By` trailer. Use the model that made the change, its actual context window, and the provider's noreply address:

  `Co-Authored-By: GPT-6-Sol (1M context) <noreply@openai.com>`

  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

  These are format examples. Do not copy a model name or context size from an earlier commit unless it matches the current session. If the context window is unavailable, say `context unknown` instead of guessing. Use plain angle brackets around the email address so Git recognizes the trailer.
