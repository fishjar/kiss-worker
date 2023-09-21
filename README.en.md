# KISS-WORKER

A simple data sync service for [KISS-Translator](https://github.com/fishjar/kiss-translator).

There are two deployment methods to choose from:

## `cloudflare workers` deployment method

### Prerequisites

- [Cloudflare](https://www.cloudflare.com/) account
- Install `git` + `nodejs` locally when deploying
- A domain name (optional)

### Deployment steps

1. Log in to the Cloudflare management panel and go to the path `dashboard > select Workers & Pages > KV`. Create a namespace with whatever name you want. After creation, a `namespace ID` will be obtained.

2. Clone the project, modify the `wrangler.toml` file, and replace the `namespace ID` obtained in the previous step to the position of `id`.

```toml
# wrangler.toml
kv_namespaces = [
    { binding = "KV", id = "replace you id here!!!" }
]
```

3. Execute the following commands in sequence. When the execution is completed, you will be asked to set your own password. You may need to connect to Cloudflare authorization when deploying for the first time.

```sh
yarn install
yarn deploy
```

4. (Optional) Log in to the Cloudflare management panel, enter the path `dashboard > select Workers & Pages > kiss-worker`, click the `Trigger` tab, and then click `Add Custom Domain` to add a domain name to access.

## `docker` deployment method

### Prerequisites

- Own server
- `docker` related knowledge

### Deployment steps

1. Clone the project and modify the `docker-compose.yml` file to change the characters after `APP_KEY` to your own password.

```yml
version: "3.1"
services:
  kiss-worker:
    image: fishjar/kiss-worker
    environment:
      PORT: 8080
      APP_KEY: 123456 # Change password here
      APP_DATAPATH: data
    ports:
      - 8080:8080
    volumes:
      - ./data:/app/data
```

2. Execute the following command to start

```sh
docker-compose up -d
```
