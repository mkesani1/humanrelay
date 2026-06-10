// Root-level Vercel function: serves api.humanrelay.com from the same project
// that hosts the static site (vercel.json routes by Host header).
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, default } from "../platform/api/index.js";
