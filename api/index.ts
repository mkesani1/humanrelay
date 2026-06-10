// Root-level Vercel function: serves api.humanrelay.com from the same project
// that hosts the static site (vercel.json routes by Host header).
//
// Explicit Node-style (req, res) handler via @hono/node-server so Vercel's
// runtime mode detection can't misfire — the web-handler form caused 504s.
import { getRequestListener } from "@hono/node-server";
import webHandler from "../platform/api/index.js";

export default getRequestListener(webHandler);
