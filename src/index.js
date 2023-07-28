/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npx wrangler dev src/index.js` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npx wrangler publish src/index.js --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const AUTH_KEY = "X-KISS-PSK";
const RULES_KEY = "KT_RULES";
const SETTING_KEY = "KT_SETTING";

export default {
  async fetch(request, env, ctx) {
    // console.log("request", request, env);
    if (request.method !== "POST") {
      return new Response("Method Not Allowed.", {
        status: 405,
      });
    }

    if (!env.AUTH_VALUE) {
      return new Response("Must set AUTH_VALUE environment.", {
        status: 503,
      });
    }

    const psk = request.headers.get(AUTH_KEY);
    if (psk !== env.AUTH_VALUE) {
      return new Response("Sorry, you have supplied an invalid key.", {
        status: 403,
      });
    }

    const merge = async (key, data) => {
      const { value, metadata } = await env.KV.getWithMetadata(key, {
        type: "json",
      });
      // console.log("kv", value, metadata);
      if (value && metadata?.updateAt > data.updateAt) {
        return {
          value,
          updateAt: metadata.updateAt,
        };
      }

      await env.KV.put(key, JSON.stringify(data.value), {
        metadata: {
          updateAt: data.updateAt,
        },
      });
      return data;
    };

    try {
      const data = await request.json();
      // console.log("data", data);
      if (!(data.hasOwnProperty("value") && data.hasOwnProperty("updateAt"))) {
        return new Response("Need value and updateAt fields.", {
          status: 400,
        });
      }

      let res;
      const { pathname } = new URL(request.url);
      switch (pathname) {
        case "/rules":
          res = await merge(RULES_KEY, data);
          break;
        case "/setting":
          res = await merge(SETTING_KEY, data);
          break;
        default:
          return new Response("Not Found.", { status: 404 });
      }

      return new Response(JSON.stringify(res), {
        headers: {
          "content-type": "application/json;charset=UTF-8",
        },
      });
    } catch (err) {
      return new Response(`Unknown Error: ${err.message}`, { status: 500 });
    }
  },
};
