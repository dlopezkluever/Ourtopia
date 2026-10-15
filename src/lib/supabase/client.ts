import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { Database } from './database.types';

const configuration = z.object({
  url: z.url(),
  key: z.string().min(20),
}).parse({ url: import.meta.env.VITE_SUPABASE_URL, key: import.meta.env.VITE_SUPABASE_ANON_KEY });

export const supabase = createClient<Database>(configuration.url, configuration.key);
