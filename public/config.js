// Fallback only. In the VPS build /config.js is generated dynamically by server.js
// from backend/.env, so do not hard-code environment-specific values here.
window.NLN_CONFIG = window.NLN_CONFIG || {
  API_BASE_URL: "",
  GOOGLE_CLIENT_ID: ""
};
