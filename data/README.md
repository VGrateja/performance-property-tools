# `data/`

Seed inputs for one-off scripts. Files here are read by the matching script
in `scripts/`; nothing in this folder is shipped with the app at runtime.

## `scrabble-words.txt`

Word list for the Scrabble dictionary table (`public.scrabble_words`).

- One UPPERCASE word per line.
- 2–15 letters; only A–Z (any apostrophes / hyphens are stripped by the
  seed script).
- SOWPODS (≈270k words) is the international Scrabble standard. TWL06
  (≈178k words) is the North American alternative — pick one.

This file is **not** committed because the standard word lists are
licensed by Collins/Hasbro. Drop your own copy in place, then run:

```bash
SUPABASE_URL=https://<ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<service-role-key> \
npm run seed-scrabble-words
```

Re-running the script is safe — duplicate rows are ignored via the
table's primary-key constraint.
