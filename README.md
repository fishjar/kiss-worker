# KISS-WORKER

A simple data sync service for [KISS-Translator](https://github.com/fishjar/kiss-translator).

## 1、Clone repository

```sh
git clone https://github.com/fishjar/kiss-worker
```

## 2、Create a KV and replace you KV id

Sign up for a [Cloudflare](https://www.cloudflare.com/) account if you don't have one.

Create a KV namespace in the dashboard by logging into the [Cloudflare](https://www.cloudflare.com/) dashboard > select Workers & Pages > KV.

```toml
# wrangler.toml
kv_namespaces = [
    { binding = "KV", id = "replace you id here!!!" }
]
```

## 3、Deploy and enter a secret value

```sh
yarn
yarn deploy
```
