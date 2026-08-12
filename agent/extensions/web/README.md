# web extension

`webfetch` + `websearch`. Reddit / X are routed inside `webfetch` and need cookie env vars.

## Reddit

```bash
export REDDIT_SESSION='…'   # cookie: reddit_session
```

Log in at reddit.com → DevTools → Application → Cookies → copy `reddit_session` value.

Supports `reddit.com` / `redd.it` (listings, posts, short links).

## Twitter / X

```bash
export TWITTER_AUTH_TOKEN='…'  # cookie: auth_token
export TWITTER_CT0='…'           # cookie: ct0
```

Log in at x.com → Cookies → copy `auth_token` and `ct0`.

Status URLs only, e.g. `https://x.com/user/status/123`.

## Notes

Use a secondary account. Re-export when cookies expire.
