// Browser entry point. The only configuration the browser receives is the
// Supabase project URL and its publishable key (checked by the build guard).

import { createClient } from '@supabase/supabase-js';
import { createApi, createAuth } from './api.js';
import { createApp } from './app.js';
import './styles.css';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const root = document.getElementById('app');

if (!url || !key) {
  root.textContent = 'Eden HQ is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY.';
} else {
  const client = createClient(url, key, {
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    db: { schema: 'eden_api' },
  });
  const app = createApp({
    root,
    api: createApi(client),
    auth: createAuth(client, { origin: window.location.origin }),
  });
  app.render();
}
