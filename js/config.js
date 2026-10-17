// Supabase connection + small shared helpers.
window.MENDOZA_CONFIG = {
  SUPABASE_URL: 'https://rknsbfykyulrejnbwjuf.supabase.co',
  SUPABASE_KEY: 'sb_publishable_1eOKsHa61pzfly5n4DMutg_hOpDQLMe'
};

(function () {
  var cfg = window.MENDOZA_CONFIG;
  if (!window.supabase || !window.supabase.createClient) {
    console.error('Supabase library failed to load.');
    return;
  }
  // Global database client used by login.js and app.js
  window.db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);
})();

// Session helpers (stored in localStorage so both pages can share it).
var Session = {
  KEY: 'mendoza_session',
  save: function (user) { localStorage.setItem(this.KEY, JSON.stringify(user)); },
  get: function () {
    try { return JSON.parse(localStorage.getItem(this.KEY) || 'null'); }
    catch (e) { return null; }
  },
  clear: function () { localStorage.removeItem(this.KEY); }
};
window.Session = Session;

// Format a number as Philippine peso.
function peso(n) {
  var v = Number(n || 0);
  return '₱' + v.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
window.peso = peso;
